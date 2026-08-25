// tests/tier1/core-undo.test.js — src/js/core/undo.js.
// ADR 001 §7.1 (rules U1–U10) · ops.contract.js §7 · store.contract.js · PLAN risk R5.
// Stories 5.4 (solo undo/redo), 18.4 (own actions only), 18.6 (undo of a delete resurrects).
//
// WHAT THIS FILE HAS TO PROVE, in the order it proves it:
//
//   1. The inverse rules are the ADR's, exactly — including the two that are easy to get subtly
//      wrong and impossible to notice: `_born` is never written by an inverse op, and the inverse
//      of a create is a tombstone rather than a blanking of every field.
//   2. v1's solo semantics survive VERBATIM: 50 groups, redo dropped on a new mutation, a decline
//      leaving no trace, settings outside history. The v1 characterization suite
//      (tests/tier1/store-persistence.test.js) encodes those as facts about the real v1 store;
//      every one of them is re-asserted here against the op-log model.
//   3. Story 18.4 structurally: another member's ops cannot reach this device's stacks, and the
//      remote path cannot clear the redo branch.
//   4. This is a module inside a SYNC system, so undo is tested under reorder, duplicate delivery,
//      interleaving and partition/heal — not only on a quiet single-device timeline.
//   5. The shadow-undo assertion (risk R5) actually bites: a reference v1-style snapshot undo runs
//      beside the op-log undo over seeded random action sequences and the two are compared after
//      EVERY step, and a deliberately sabotaged pre-image is shown to fail rather than pass.
//
// The reference implementations here (`refFold`, `refMaterialize`, `V1RefStore`) are TEST
// SCAFFOLDING, deliberately independent of anything under src/js/core/ that does not exist yet
// (registers.js and materialize.js are later work packages). They are the *second* opinion the
// property test needs; they are not a specification and nothing may import them.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeOp, opKindForEntity, MUTATIONS, PERSONAL_PLACEHOLDER, LOCAL_SPACE,
  validateOp, FIELDS,
} from '../../src/js/core/ops.js';
import {
  parseEntityKey, kindOfEntity, noteKey, barKey, catKey, padKey, PREF_KEY,
  familyKey, renderableNote, renderableBar,
  sortNotes, sortBars, sortCategories, sortScratchpads,
} from '../../src/js/core/entities.js';
import { createClock, fmt, cmp, isStamp } from '../../src/js/core/stamp.js';
import { ZERO_DEVICE_SHORT } from '../../src/js/core/ids.js';
import { b64u } from '../../src/js/core/b64.js';
import { applyOp as realApplyOp, emptyRegisters } from '../../src/js/core/registers.js';
import { materialize as realMaterialize, V2_ENTRY_FIELDS } from '../../src/js/core/materialize.js';

// ─────────────────────────────────────────────────────────────────────────────
// Arm the shadow-undo assertion for this whole file.
//
// `dev.js` reads `globalThis.__LZP_DEV` ONCE, at import time, on purpose (a flag that can flip
// mid-run gives you a txn that captured no shadow and an undo that then demands one). A static
// `import` is hoisted above every statement in a module, so the flag has to be set before the
// module graph that reads it is evaluated — hence the dynamic import below. None of the modules
// statically imported above touches dev.js.
//
// ADR 001 §7.1: "The whole tier-1 + regression suite runs with it on."
// ─────────────────────────────────────────────────────────────────────────────
globalThis.__LZP_DEV = true;
const { DEV } = await import('../../src/js/core/dev.js');
const {
  createUndoStacks, makeTx, captureImages, opsFromImage,
  shadowContent, firstDifference, sameContent,
  readRegister, preValueOf, entityExists,
  UNDO_LIMIT, UNDOABLE_KINDS, CONTENT_KEYS, UndoError, ShadowUndoError,
} = await import('../../src/js/core/undo.js');

// ═════════════════════════════════════════════════════════════════════════════
// Harness — seeded, wall-clock-free (ADR 005 §5.5: no test reads the real clock)
// ═════════════════════════════════════════════════════════════════════════════

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randBytes = (rng, n) => Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Deterministic identifiers, so a failure is replayable from the seed alone. */
const idgen = mulberry32(0xC0FFEE);
const b22 = () => b64u(randBytes(idgen, 16));
const MEM_ME = `mem_${b22()}`;
const MEM_MAMA = `mem_${b22()}`;
const DEV_A = `dev_${b22()}`;
const DEV_B = `dev_${b22()}`;
const DS_A = 'A1B2C3D4E5F6G7H8';
const DS_B = 'ZYXWVTSRQPNMKJHG';
const T0 = 1787836800000;                     // a fixed instant; never Date.now()

function fakeClock(startMs = T0) {
  let t = startMs;
  return { now: () => t, advance(ms) { t += ms; }, set(ms) { t = ms; } };
}

/** A uuid-shaped id that satisfies `isEntityUuid` without a CSPRNG. */
let uuidCounter = 0;
function uuid() {
  const n = (uuidCounter++).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
}

// ── the reference fold: plain per-field max-by-stamp, no writeOnce protection ──
// Deliberately unprotective: if an inverse op ever wrote `_born`, this fold would apply it and
// the "_born survives undo/redo" assertions would go red. A reference that quietly defended the
// invariant would hide exactly the bug those assertions exist to find.
function refFold(regs, op) {
  let cell = regs.get(op.e);
  if (!cell) { cell = new Map(); regs.set(op.e, cell); }
  let changed = false;
  for (const [f, v] of Object.entries(op.f)) {
    const cur = cell.get(f);
    if (!cur || cmp(cur.stamp, op.ts) < 0) {
      cell.set(f, { value: v, stamp: op.ts, author: op.act });
      changed = true;
    }
  }
  return changed;
}

/** A canonical dump, so two devices' register maps can be compared as strings. */
function dumpRegs(regs) {
  const rows = [];
  for (const [e, cell] of regs) {
    for (const [f, r] of cell) rows.push([e, f, r.value, r.stamp, r.author]);
  }
  rows.sort((a, b) => (a[0] + '\u0000' + a[1] < b[0] + '\u0000' + b[1] ? -1 : 1));
  return JSON.stringify(rows);
}

/** Expand `pref` dotted register names back into the nested v1 settings shape. */
function expandPrefs(cell) {
  const out = {};
  if (!cell) return out;
  for (const [k, r] of cell) {
    if (r.value === null) continue;
    const parts = k.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts.at(-1)] = r.value;
  }
  return out;
}

/**
 * RegisterMap → the v1 state shape, solo mode. ADR 001 §5 steps 1, 3 and 5 only — enough to test
 * undo, and no more. materialize.js (WP-1's remaining half) is the real thing.
 */
function refMaterialize(regs) {
  const notes = []; const bars = []; const cats = []; const pads = {};
  let prefCell = null;
  for (const [e, cell] of regs) {
    const p = parseEntityKey(e);
    if (!p) continue;
    if (p.kind === 'pref') { prefCell = cell; continue; }
    const ent = { id: p.id };
    for (const [f, r] of cell) {
      if (r.value === null) continue;             // step 1: null is cleared, never a value
      ent[f] = r.value;
    }
    if (ent._alive === false) continue;           // step 3
    if (p.kind === 'note' && renderableNote(ent)) notes.push(ent);
    else if (p.kind === 'bar' && renderableBar(ent)) bars.push(ent);
    else if (p.kind === 'cat') cats.push(ent);
    else if (p.kind === 'pad' && typeof ent.text === 'string') pads[p.id] = ent.text;
  }
  return {
    schemaVersion: 2,
    notes: sortNotes(notes),                      // step 5 — mandatory, not cosmetic
    bars: sortBars(bars),
    categories: sortCategories(cats),
    scratchpads: sortScratchpads(pads),
    settings: expandPrefs(prefCell),
  };
}

/**
 * The system under test, wired the way `store.txn()` will be (ADR 001 §7.1's snippet):
 * capture images and shadow from the PRE-state, apply, materialise, push, clear redo, emit.
 */
class TestStore {
  constructor(opts = {}) {
    this.act = opts.act ?? MEM_ME;
    this.dev = opts.dev ?? DEV_A;
    this.wall = opts.wall ?? fakeClock();
    this.clock = createClock(opts.deviceShort ?? DS_A, this.wall.now);
    this.rng = mulberry32(opts.seed ?? 7);
    this.regs = new Map();
    this.emitted = [];                            // ops THIS device authored, in order
    this.events = [];                             // emit() reasons, v1's broadcast contract
    this.sabotage = opts.sabotage ?? null;        // negative control for the shadow assertion
    // `real: true` swaps the local reference fold/projection for the SHIPPING registers.js and
    // materialize.js. Both paths must produce identical undo behaviour; see the cross-check block.
    this.real = !!opts.real;
    if (this.real) this.regs = emptyRegisters();
    this.verified = 0;                            // how many times the shadow actually CHECKED
    this.stacks = createUndoStacks({
      act: this.act,
      dev: this.dev,
      mint: () => this.clock.tick(),
      newOpId: () => b64u(randBytes(this.rng, 16)),
      newGid: () => b64u(randBytes(this.rng, 16)),
      limitGroups: opts.limitGroups,
      shadow: opts.shadow,
      space: PERSONAL_PLACEHOLDER,
    });
    this.state = refMaterialize(this.regs);
  }

  _ctxFields() {
    return {
      act: this.act,
      dev: this.dev,
      mint: () => this.clock.tick(),
      newOpId: () => b64u(randBytes(this.rng, 16)),
      newGid: () => b64u(randBytes(this.rng, 16)),
      space: PERSONAL_PLACEHOLDER,
    };
  }

  _apply(op) { return this.real ? realApplyOp(this.regs, op) : refFold(this.regs, op); }
  _materialize() { this.state = this.real ? realMaterialize(this.regs, {}) : refMaterialize(this.regs); }
  emit(reason) { this.events.push(reason); }

  /** ADR 001 §7.1's `tx()`, line for line. */
  txn(label, fn) {
    const tx = makeTx({ state: this.state, regs: this.regs, ...this._ctxFields() });
    const r = fn(tx);
    if (r === false || tx.ops.length === 0) return r;      // store.js:150, verbatim
    let { pre, post } = tx.images();                        // PRE-state, synchronous
    if (this.sabotage) pre = this.sabotage(pre);
    const shadow = this.stacks.shadowArmed ? shadowContent(this.state) : undefined;
    for (const op of tx.ops) { this._apply(op); this.emitted.push(op); }
    this._materialize();
    this.stacks.push(tx.gid, label, pre, post, shadow);
    this.emit(label);
    return r;
  }

  undo() {
    const ops = this.stacks.undo(this.state);
    if (!ops.length) return false;
    for (const op of ops) { this._apply(op); this.emitted.push(op); }
    this._materialize();
    if (this.stacks.verify(this.state)) this.verified++;
    this.emit('undo');
    return true;
  }

  redo() {
    const ops = this.stacks.redo(this.state);
    if (!ops.length) return false;
    for (const op of ops) { this._apply(op); this.emitted.push(op); }
    this._materialize();
    if (this.stacks.verify(this.state)) this.verified++;
    this.emit('redo');
    return true;
  }

  /** Rule U2: touches NEITHER stack, and never clears redo. `remoteApplied()` retires the
   *  DEV-only whole-content shadow expectation and nothing else. */
  applyRemote(ops) {
    for (const op of ops) {
      if (op.dev !== this.dev) this.clock.observe(op.ts);
      this._apply(op);
    }
    this.stacks.remoteApplied();
    this._materialize();
    this.emit('remote');
  }

  /** v1's `setSettings` — configuration, outside history (5.4, rule U6). */
  setSettings(patch) {
    const ctx = { ...this._ctxFields(), gid: null, newOpId: this._ctxFields().newOpId };
    const op = makeOp({ ...ctx, gid: b64u(randBytes(this.rng, 16)) }, 'pref.set', PREF_KEY, patch);
    this._apply(op);
    this.emitted.push(op);
    this._materialize();
    this.emit('settings');
  }

  canUndo() { return this.stacks.canUndo(); }
  canRedo() { return this.stacks.canRedo(); }

  /** Seed like a migration would: ops folded straight in, no transaction, no undo entry. */
  seed(build) {
    let i = 0;
    const ctx = {
      act: this.act,
      dev: this.dev,
      gid: b64u(randBytes(this.rng, 16)),
      mint: () => fmt(0, i++, ZERO_DEVICE_SHORT),
      newOpId: () => b64u(randBytes(this.rng, 16)),
      space: PERSONAL_PLACEHOLDER,
    };
    for (const op of build(ctx)) { this._apply(op); this.emitted.push(op); }
    this._materialize();
    return this;
  }
}

const cloneRegs = (regs) => new Map([...regs].map(([e, cell]) => [e, new Map(cell)]));

const CAT1 = uuid();
const CAT2 = uuid();

/** Two categories, born at GENESIS stamps so every later edit beats them. */
function seededStore(opts = {}) {
  const s = new TestStore(opts);
  s.seed((ctx) => [
    makeOp(ctx, 'cat.set', catKey(CAT1), {
      name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true,
      defaultVisibility: 'privat', _alive: true, _born: fmt(0, 900000, ZERO_DEVICE_SHORT),
    }),
    makeOp(ctx, 'cat.set', catKey(CAT2), {
      name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true,
      defaultVisibility: 'privat', _alive: true, _born: fmt(0, 900001, ZERO_DEVICE_SHORT),
    }),
  ]);
  return s;
}

/** The v1-shaped normalisation both implementations are compared through. */
const normNote = (n) => ({ id: n.id, date: n.date, text: n.text, categoryId: n.categoryId, repeatsYearly: !!n.repeatsYearly });
const normBar = (b) => ({ id: b.id, startDate: b.startDate, endDate: b.endDate, label: b.label, categoryId: b.categoryId });
const normCat = (c) => {
  const o = { id: c.id, name: c.name, paletteRef: c.paletteRef, visible: c.visible !== false };
  if (c.nameEn !== undefined) o.nameEn = c.nameEn;
  return o;
};
const normContent = (st) => ({
  notes: st.notes.map(normNote),
  bars: st.bars.map(normBar),
  categories: st.categories.map(normCat),
  scratchpads: { ...st.scratchpads },
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. The inverse rules (ADR 001 §7.1, "Inverse computation")
// ═════════════════════════════════════════════════════════════════════════════

describe('inverse ops — the four rules (ADR 001 §7.1)', () => {
  test('a plain field change inverts to the value the register held before it', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-03-01', text: 'Kickoff', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('move-note', (tx) => tx.note(id).set({ date: '2026-03-09' }));
    assert.equal(s.state.notes[0].date, '2026-03-09');

    const entry = s.stacks.peekUndo();
    assert.deepEqual(entry.pre.map((t) => [...t]), [[noteKey(id), 'date', '2026-03-01']]);
    assert.deepEqual(entry.post.map((t) => [...t]), [[noteKey(id), 'date', '2026-03-09']]);
    s.undo();
    assert.equal(s.state.notes[0].date, '2026-03-01');
  });

  test('the inverse of a create is `{_alive:false}` — and NOTHING else', () => {
    // The content registers are deliberately left standing (ADR 001 §6, "Delete/edit races
    // converge"). Blanking them would make a peer's concurrent co-edit vanish with my ⌘Z.
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-03-01', text: 'Zahnarzt', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    const before = s.emitted.length;
    s.undo();
    const inverse = s.emitted.slice(before);
    assert.equal(inverse.length, 1);
    assert.deepEqual(inverse[0].f, { _alive: false });
    assert.deepEqual(s.state.notes, []);
    // and the text register survived, untouched
    assert.equal(readRegister(s.regs, noteKey(id), 'text').value, 'Zahnarzt');
  });

  test('the inverse of a delete is `{_alive:true}` on the ORIGINAL entity id (18.6)', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-04-02', text: 'Impfung', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('delete-note', (tx) => tx.note(id).del());
    const before = s.emitted.length;
    s.undo();
    const [op] = s.emitted.slice(before);
    assert.equal(op.e, noteKey(id), 'the SAME entity key — a resurrect, not a duplicate');
    assert.deepEqual(op.f, { _alive: true });
    assert.equal(s.state.notes[0].text, 'Impfung');
  });

  test('`_born` is never written by an inverse op, in either direction', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-05-05', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    const born = readRegister(s.regs, noteKey(id), '_born').value;
    const before = s.emitted.length;
    s.undo();
    s.redo();
    for (const op of s.emitted.slice(before)) {
      assert.ok(!('_born' in op.f), `an inverse op wrote _born: ${JSON.stringify(op.f)}`);
    }
    assert.equal(readRegister(s.regs, noteKey(id), '_born').value, born, '_born is write-once and must survive');
  });

  test('undo→redo of a create restores the entry to its ORIGINAL array position', () => {
    // This is what preserving `_born` buys: the sort key is unchanged, so the note comes back
    // where it was rather than at the end. `layout.js`'s capacity slice is order-sensitive.
    const s = seededStore();
    const a = uuid(); const b = uuid(); const c = uuid();
    for (const [id, text] of [[a, 'eins'], [b, 'zwei'], [c, 'drei']]) {
      s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-06-01', text, categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    }
    assert.deepEqual(s.state.notes.map((n) => n.text), ['eins', 'zwei', 'drei']);
    s.undo(); s.undo();                                   // drop 'drei' and 'zwei'
    assert.deepEqual(s.state.notes.map((n) => n.text), ['eins']);
    s.redo();                                             // 'zwei' comes back in the middle
    assert.deepEqual(s.state.notes.map((n) => n.text), ['eins', 'zwei']);
    s.redo();
    assert.deepEqual(s.state.notes.map((n) => n.text), ['eins', 'zwei', 'drei']);
  });

  test('a field whose register did not exist inverts to an explicit null', () => {
    const s = seededStore();
    // `renameCategory` DE writes `{name, nameEn: null}`; undo restores the English name.
    s.txn('rename-category', (tx) => tx.cat(CAT1).set({ name: 'Projekte', nameEn: null }));
    assert.equal(s.state.categories[0].name, 'Projekte');
    assert.equal(s.state.categories[0].nameEn, undefined);
    s.undo();
    assert.equal(s.state.categories[0].name, 'Arbeit');
    assert.equal(s.state.categories[0].nameEn, 'Work');
  });

  test('preValueOf reconstructs a missing `_alive` rather than restoring null', () => {
    // ADR 001 §5 step 3: meaning is never inferred from a missing field. An entity with other
    // registers and no `_alive` exists and is alive; an entity with no registers at all does not.
    const regs = new Map([['note:x', new Map([['date', { value: '2026-01-01', stamp: fmt(1, 0, DS_A), author: MEM_ME }]])]]);
    assert.equal(preValueOf(regs, 'note:x', '_alive'), true);
    assert.equal(preValueOf(regs, 'note:missing', '_alive'), false);
    assert.equal(preValueOf(regs, 'note:x', 'text'), null);
    assert.equal(entityExists(regs, 'note:x'), true);
    assert.equal(entityExists(regs, 'note:missing'), false);
  });

  test('every emitted inverse op is a legal op and carries an ABSOLUTE value', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-bar', (tx) => tx.bar(id).create({ startDate: '2026-07-01', endDate: '2026-07-10', label: '', categoryId: CAT1, visibility: 'privat', coEdit: false }));
    s.txn('move-bar', (tx) => tx.bar(id).set({ startDate: '2026-07-05', endDate: '2026-07-14' }));
    const before = s.emitted.length;
    s.undo(); s.redo(); s.undo();
    const RELATIVE = /delta|offset|shift|^by$|increment|adjust/i;
    for (const op of s.emitted.slice(before)) {
      assert.deepEqual(validateOp(op), { ok: true }, `invalid inverse op: ${JSON.stringify(op)}`);
      for (const f of Object.keys(op.f)) {
        assert.ok(!RELATIVE.test(f), `inverse op field "${f}" reads as a relative change`);
      }
    }
  });

  test('one op per entity, so all of an entity\'s restored fields share one stamp', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-bar', (tx) => tx.bar(id).create({ startDate: '2026-07-01', endDate: '2026-07-10', label: '', categoryId: CAT1, visibility: 'privat', coEdit: false }));
    s.txn('resize-bar', (tx) => tx.bar(id).set({ startDate: '2026-06-28', endDate: '2026-07-20' }));
    const before = s.emitted.length;
    s.undo();
    const inverse = s.emitted.slice(before);
    assert.equal(inverse.length, 1);
    assert.deepEqual(Object.keys(inverse[0].f).sort(), ['endDate', 'startDate']);
  });

  test('inverse ops carry my act/dev, fresh opIds, a fresh gid and strictly increasing stamps', () => {
    const s = seededStore();
    const n = uuid(); const b = uuid();
    s.txn('fan', (tx) => { tx.note(n).create({ date: '2026-08-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }); tx.bar(b).create({ startDate: '2026-08-01', endDate: '2026-08-03', label: 'B', categoryId: CAT1, visibility: 'privat', coEdit: false }); });
    const gidOfTxn = s.stacks.peekUndo().gid;
    const before = s.emitted.length;
    s.undo();
    const inverse = s.emitted.slice(before);
    assert.equal(inverse.length, 2);
    const gids = new Set(inverse.map((o) => o.gid));
    assert.equal(gids.size, 1, 'one undo is one group (rule U1)');
    assert.notEqual([...gids][0], gidOfTxn, 'and it is a FRESH gid — an undo is its own user action');
    assert.equal(new Set(inverse.map((o) => o.id)).size, 2, 'fresh, distinct opIds (rule U4)');
    for (const op of inverse) {
      assert.equal(op.act, MEM_ME);
      assert.equal(op.dev, DEV_A);
      assert.equal(op.space, PERSONAL_PLACEHOLDER);
      assert.ok(isStamp(op.ts));
    }
    assert.ok(cmp(inverse[0].ts, inverse[1].ts) < 0, 'stamps strictly increase within the group');
    const newest = s.emitted.slice(0, before).map((o) => o.ts).sort().at(-1);
    assert.ok(cmp(newest, inverse[0].ts) < 0, 'and beat every stamp this device had already written');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. captureImages — the pre/post images
// ═════════════════════════════════════════════════════════════════════════════

describe('captureImages', () => {
  const ctx = () => ({
    act: MEM_ME, dev: DEV_A, gid: b22(), mint: (() => { let i = 0; return () => fmt(T0, i++, DS_A); })(),
    newOpId: () => b22(), space: PERSONAL_PLACEHOLDER,
  });

  test('a create collapses to a single `_alive` pair, dropping its other fields', () => {
    const c = ctx();
    const id = uuid();
    const op = makeOp(c, 'note.set', noteKey(id), { date: '2026-01-01', text: 'x', categoryId: CAT1, _alive: true }, { born: true });
    const { pre, post } = captureImages(new Map(), [op], { me: MEM_ME });
    assert.deepEqual(pre.map((t) => [...t]), [[noteKey(id), '_alive', false]]);
    assert.deepEqual(post.map((t) => [...t]), [[noteKey(id), '_alive', true]]);
  });

  test('a create plus a later write to the SAME entity in one group still collapses', () => {
    const c = ctx();
    const id = uuid();
    const ops = [
      makeOp(c, 'note.set', noteKey(id), { date: '2026-01-01', text: 'x', categoryId: CAT1, _alive: true }, { born: true }),
      makeOp(c, 'note.set', noteKey(id), { text: 'y' }),
    ];
    const { pre, post } = captureImages(new Map(), ops, { me: MEM_ME });
    assert.deepEqual(pre.map((t) => [...t]), [[noteKey(id), '_alive', false]]);
    assert.deepEqual(post.map((t) => [...t]), [[noteKey(id), '_alive', true]]);
  });

  test('two writes to one field in one group: pre keeps the FIRST value, post the LAST', () => {
    const c = ctx();
    const id = uuid();
    const regs = new Map([[noteKey(id), new Map([['date', { value: '2026-01-01', stamp: fmt(1, 0, DS_A), author: MEM_ME }]])]]);
    const ops = [
      makeOp(c, 'note.set', noteKey(id), { date: '2026-02-02' }),
      makeOp(c, 'note.set', noteKey(id), { date: '2026-03-03' }),
    ];
    const { pre, post } = captureImages(regs, ops, { me: MEM_ME });
    assert.deepEqual(pre.map((t) => [...t]), [[noteKey(id), 'date', '2026-01-01']]);
    assert.deepEqual(post.map((t) => [...t]), [[noteKey(id), 'date', '2026-03-03']]);
  });

  test('`pref` writes are filtered out — rule U6, and v1\'s CONTENT_KEYS one for one', () => {
    const c = ctx();
    const id = uuid();
    const ops = [
      makeOp(c, 'note.set', noteKey(id), { text: 'neu' }),
      makeOp(c, 'pref.set', PREF_KEY, { lastCategoryId: CAT2 }),
    ];
    const { pre, post } = captureImages(new Map(), ops, { me: MEM_ME });
    assert.equal(pre.length, 1);
    assert.equal(post.length, 1);
    assert.equal(pre[0][0], noteKey(id));
    assert.deepEqual(CONTENT_KEYS, ['notes', 'bars', 'categories', 'scratchpads']);
    assert.deepEqual(UNDOABLE_KINDS, ['note', 'bar', 'cat', 'pad']);
  });

  test('family (`pub.set`) registers are not undoable — publication is re-derived, never undone', () => {
    const c = { ...ctx(), familySpaceId: `fsp_${b22()}` };
    const key = familyKey('fnote', MEM_ME, uuid());
    const op = makeOp(c, 'pub.set', key, { 'pub.level': 'geteilt', 'pub.text': 'x' });
    const { pre, post } = captureImages(new Map(), [op], { me: MEM_ME });
    assert.deepEqual(pre, []);
    assert.deepEqual(post, []);
  });

  test('order is deterministic: entities in first-appearance order, fields likewise', () => {
    const c = ctx();
    const a = uuid(); const b = uuid();
    const ops = [
      makeOp(c, 'bar.set', barKey(b), { endDate: '2026-01-09', startDate: '2026-01-02' }),
      makeOp(c, 'note.set', noteKey(a), { text: 'z' }),
    ];
    const { pre } = captureImages(new Map(), ops, { me: MEM_ME });
    assert.deepEqual(pre.map((t) => [t[0], t[1]]), [
      [barKey(b), 'endDate'], [barKey(b), 'startDate'], [noteKey(a), 'text'],
    ]);
  });

  test('the images hold NO op, NO stamp, NO author and NO opId (rule U3 — privacy)', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'geheim', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    const entry = s.stacks.peekUndo();
    assert.deepEqual(Object.keys(entry).sort(), ['gid', 'label', 'post', 'pre']);
    for (const t of [...entry.pre, ...entry.post]) {
      assert.equal(t.length, 3, 'entries are [entityKey, field, value] triples and nothing more');
      assert.ok(typeof t[0] === 'string' && typeof t[1] === 'string');
    }
    assert.ok(!JSON.stringify(entry).includes('"ts"'));
    assert.ok(!JSON.stringify(entry).includes('"act"'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Story 18.4 — scoped strictly to MY OWN actions
// ═════════════════════════════════════════════════════════════════════════════

describe('18.4 — another member\'s ops never enter my undo stack', () => {
  test('captureImages refuses an op authored by someone else', () => {
    const c = { act: MEM_MAMA, dev: DEV_B, gid: b22(), mint: () => fmt(T0, 1, DS_B), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER };
    const foreign = makeOp(c, 'note.set', noteKey(uuid()), { text: 'Mamas Notiz' });
    assert.throws(
      () => captureImages(new Map(), [foreign], { me: MEM_ME }),
      (e) => e instanceof UndoError && /18\.4/.test(e.message),
    );
  });

  test('a MIXED log leaves the stack holding only my groups', () => {
    // Mama's device and my second device both push into the log. Only the two groups I authored
    // through txn() are reachable with ⌘Z, in my order, regardless of what arrived in between.
    const me = seededStore();
    const mamaId = uuid();
    const mineA = uuid();
    const mineB = uuid();

    const mama = new TestStore({ act: MEM_MAMA, dev: DEV_B, deviceShort: DS_B, seed: 99, wall: fakeClock(T0) });
    mama.regs = cloneRegs(me.regs);               // her own copy of the same board
    mama._materialize();

    me.txn('create-note', (tx) => tx.note(mineA).create({ date: '2026-02-01', text: 'meins A', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    mama.wall.advance(10);
    mama.txn('create-note', (tx) => tx.note(mamaId).create({ date: '2026-02-02', text: 'Mamas', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    me.applyRemote(mama.emitted.slice(-1));
    me.txn('create-note', (tx) => tx.note(mineB).create({ date: '2026-02-03', text: 'meins B', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    mama.wall.advance(10);
    mama.txn('edit-note', (tx) => tx.note(mamaId).set({ text: 'Mamas, geändert' }));
    me.applyRemote(mama.emitted.slice(-1));

    assert.deepEqual(me.stacks.labels(), ['create-note', 'create-note']);
    assert.equal(me.state.notes.length, 3);

    me.undo();
    assert.deepEqual(me.state.notes.map((n) => n.text).sort(), ['Mamas, geändert', 'meins A']);
    me.undo();
    assert.deepEqual(me.state.notes.map((n) => n.text), ['Mamas, geändert'], 'Mamas Notiz survived both of my undos');
    assert.equal(me.canUndo(), false, 'and there was never anything of hers to undo');
  });

  test('applyRemote touches neither stack and NEVER clears the redo branch (rule U2)', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-03-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.undo();
    assert.equal(s.canRedo(), true);

    const peer = new TestStore({ act: MEM_MAMA, dev: DEV_B, deviceShort: DS_B, seed: 5, wall: fakeClock(T0 + 500) });
    peer.regs = cloneRegs(s.regs);
    peer._materialize();
    peer.txn('create-note', (tx) => tx.note(uuid()).create({ date: '2026-03-02', text: 'peer', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));

    const beforeSize = s.stacks.size();
    s.applyRemote(peer.emitted.slice(-1));
    assert.deepEqual(s.stacks.size(), beforeSize, 'neither stack moved');
    assert.equal(s.canRedo(), true, 'the redo branch is still there');
    s.redo();
    assert.equal(s.state.notes.length, 2, 'my redo restored mine; the peer\'s note stayed');
  });

  test('undo restores what was there before MY action, even when a peer wrote that value', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-04-01', text: 'original', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));

    const peer = new TestStore({ act: MEM_MAMA, dev: DEV_B, deviceShort: DS_B, seed: 11, wall: fakeClock(T0 + 500) });
    peer.regs = cloneRegs(s.regs); peer._materialize();
    peer.txn('edit-note', (tx) => tx.note(id).set({ text: 'von Mama' }));
    s.applyRemote(peer.emitted.slice(-1));
    assert.equal(s.state.notes[0].text, 'von Mama');

    s.txn('edit-note', (tx) => tx.note(id).set({ text: 'von mir' }));
    s.undo();
    assert.equal(s.state.notes[0].text, 'von Mama', 'my undo restores the pre-state, which was hers');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. v1 solo semantics, re-asserted against the op-log model
//    (mirrors tests/tier1/store-persistence.test.js "mutate() (5.4)" / "undo / redo (5.4)")
// ═════════════════════════════════════════════════════════════════════════════

describe('v1 solo semantics (5.4)', () => {
  const addNote = (s, text, date = '2026-01-01') => {
    const id = uuid();
    s.txn('add-note', (tx) => tx.note(id).create({ date, text, categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    return id;
  };

  test('a mutation records exactly one undo step and nothing to redo', () => {
    const s = seededStore();
    addNote(s, 'erste');
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.canUndo(), true);
    assert.equal(s.canRedo(), false);
    assert.deepEqual(s.stacks.size(), { undo: 1, redo: 0 });
  });

  test('`return false` records no undo step and emits nothing', () => {
    const s = seededStore();
    addNote(s, 'anchor');
    const eventsBefore = s.events.length;
    assert.equal(s.txn('declined', () => false), false);
    assert.equal(s.events.length, eventsBefore, 'a declined transaction is not broadcast');
    assert.deepEqual(s.stacks.size(), { undo: 1, redo: 0 });
    s.undo();
    assert.deepEqual(s.state.notes, [], 'undo went past it to the real change');
    assert.equal(s.canUndo(), false);
  });

  test('a transaction that emits ZERO ops is a decline (ADR 001 §7.1, store.contract §2)', () => {
    // DELIBERATE DIVERGENCE FROM v1, and the ADR says so in as many words. v1's
    // `mutate('x', () => 0)` records an undo step for a mutation that changed nothing
    // (store-persistence.test.js "only a strict `false` declines"). In the op-log model there is
    // no change to record, so it declines. Pinned here so the retrofit does not rediscover it.
    const s = seededStore();
    addNote(s, 'anchor');
    s.undo();
    assert.equal(s.canRedo(), true);
    for (const v of [0, '', null, undefined, NaN]) {
      assert.deepEqual(s.txn('empty', () => v), v);
    }
    assert.deepEqual(s.stacks.size(), { undo: 0, redo: 1 }, 'no step recorded, and the redo branch survived');
  });

  test('a new mutation drops the redo branch', () => {
    const s = seededStore();
    addNote(s, 'a');
    s.undo();
    assert.equal(s.canRedo(), true);
    addNote(s, 'b');
    assert.equal(s.canRedo(), false);
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.state.notes[0].text, 'b');
  });

  test('undo/redo on an empty stack change nothing and report false', () => {
    const s = seededStore();
    assert.equal(s.undo(), false);
    assert.equal(s.redo(), false);
    assert.deepEqual(s.state.notes, []);
    assert.equal(s.canUndo(), false);
    assert.equal(s.canRedo(), false);
  });

  test('the stack is capped at 50 GROUPS and drops the OLDEST first (rule U5)', () => {
    const s = seededStore();
    assert.equal(UNDO_LIMIT, 50);
    for (let i = 0; i < 60; i++) addNote(s, `n${i}`);
    assert.equal(s.state.notes.length, 60);
    let steps = 0;
    while (s.undo()) steps++;
    assert.equal(steps, 50, 'exactly 50 steps were reachable');
    assert.equal(s.state.notes.length, 10, 'the first ten edits are beyond the horizon');
    assert.equal(s.state.notes.at(-1).text, 'n9');
  });

  test('the cap counts groups, not ops: a 40-op fan-out is ONE step (rule U1)', () => {
    const s = seededStore();
    const ids = Array.from({ length: 40 }, () => uuid());
    s.txn('bulk', (tx) => {
      for (const id of ids) tx.note(id).create({ date: '2026-09-01', text: id.slice(-4), categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false });
    });
    assert.equal(s.state.notes.length, 40);
    assert.deepEqual(s.stacks.size(), { undo: 1, redo: 0 });
    s.undo();
    assert.deepEqual(s.state.notes, []);
    assert.equal(s.canUndo(), false);
  });

  test('everything undone can be redone again', () => {
    const s = seededStore();
    for (let i = 0; i < 60; i++) addNote(s, `n${i}`);
    let undone = 0; while (s.undo()) undone++;
    let redone = 0; while (s.redo()) redone++;
    assert.equal(redone, undone);
    assert.equal(s.state.notes.length, 60);
    assert.equal(s.canRedo(), false);
  });

  test('undo/redo can be interleaved without drift', () => {
    const s = seededStore();
    addNote(s, 'a'); addNote(s, 'b'); addNote(s, 'c');
    s.undo(); s.undo();
    assert.deepEqual(s.state.notes.map((n) => n.text), ['a']);
    s.redo();
    assert.deepEqual(s.state.notes.map((n) => n.text), ['a', 'b']);
    s.undo(); s.undo();
    assert.deepEqual(s.state.notes.map((n) => n.text), []);
    s.redo(); s.redo(); s.redo();
    assert.deepEqual(s.state.notes.map((n) => n.text), ['a', 'b', 'c']);
  });

  test('covers create, edit, move, resize and delete (the five 5.4 names)', () => {
    const s = seededStore();
    const n = uuid(); const b = uuid();
    s.txn('create', (tx) => {
      tx.note(n).create({ date: '2026-03-01', text: 'Kickoff', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false });
      tx.bar(b).create({ startDate: '2026-03-01', endDate: '2026-03-05', label: 'Sprint', categoryId: CAT1, visibility: 'privat', coEdit: false });
    });
    s.txn('edit', (tx) => tx.note(n).set({ text: 'Kickoff verschoben' }));
    s.txn('move', (tx) => tx.note(n).set({ date: '2026-03-09' }));
    s.txn('resize', (tx) => tx.bar(b).set({ endDate: '2026-03-20' }));
    s.txn('delete', (tx) => tx.note(n).del());

    assert.deepEqual(s.state.notes, []);
    s.undo(); assert.equal(s.state.notes.length, 1);
    s.undo(); assert.equal(s.state.bars[0].endDate, '2026-03-05');
    s.undo(); assert.equal(s.state.notes[0].date, '2026-03-01');
    s.undo(); assert.equal(s.state.notes[0].text, 'Kickoff');
    s.undo(); assert.deepEqual(s.state.notes, []);
    assert.deepEqual(s.state.bars, []);
    assert.equal(s.canUndo(), false);
  });

  test('scratchpad edits are content and therefore undoable (10.x)', () => {
    const s = seededStore();
    s.txn('pad', (tx) => tx.pad('2026-06').create({ text: 'Sommerfest' }));
    assert.equal(s.state.scratchpads['2026-06'], 'Sommerfest');
    s.txn('pad', (tx) => tx.pad('2026-06').set({ text: 'Sommerfest, verschoben' }));
    s.undo();
    assert.equal(s.state.scratchpads['2026-06'], 'Sommerfest');
    s.undo();
    assert.equal(s.state.scratchpads['2026-06'], undefined);
    s.redo(); s.redo();
    assert.equal(s.state.scratchpads['2026-06'], 'Sommerfest, verschoben');
  });

  test('category edits are content and therefore undoable (4.1)', () => {
    const s = seededStore();
    s.txn('rename-category', (tx) => tx.cat(CAT1).set({ name: 'Projekte', nameEn: null }));
    s.txn('recolor-category', (tx) => tx.cat(CAT1).set({ paletteRef: 'tuerkis' }));
    s.undo();
    assert.equal(s.state.categories[0].paletteRef, 'blau');
    s.undo();
    assert.equal(s.state.categories[0].name, 'Arbeit');
  });

  test('the pre-image is a snapshot of VALUES — later edits cannot reach into history', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('add', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'original', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('edit', (tx) => tx.note(id).set({ text: 'changed' }));
    s.txn('repeat', (tx) => tx.note(id).set({ repeatsYearly: true, date: '2026-01-01' }));
    s.undo();
    assert.equal(s.state.notes[0].repeatsYearly, false);
    assert.equal(s.state.notes[0].text, 'changed');
    s.undo();
    assert.equal(s.state.notes[0].text, 'original');
  });

  test('undo works on a board that has only ever been emptied', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'only', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('delete-all', (tx) => tx.note(id).del());
    assert.deepEqual(s.state.notes, []);
    s.undo();
    assert.equal(s.state.notes.length, 1);
  });

  test('broadcasts the transaction label; undo/redo broadcast their own', () => {
    const s = seededStore();
    addNote(s, 'a');
    s.undo();
    s.redo();
    s.setSettings({ paper: 'a3' });
    assert.deepEqual(s.events, ['add-note', 'undo', 'redo', 'settings']);
  });

  test('clear() drops both stacks — import and snapshot restore (rule U10, 5.4)', () => {
    const s = seededStore();
    addNote(s, 'a'); addNote(s, 'b');
    s.undo();
    assert.deepEqual(s.stacks.size(), { undo: 1, redo: 1 });
    s.stacks.clear();
    assert.deepEqual(s.stacks.size(), { undo: 0, redo: 0 });
    assert.equal(s.canUndo(), false);
    assert.equal(s.canRedo(), false);
    assert.equal(s.undo(), false);
  });

  test('the stacks are per instance — U7\'s "undo knows this Mac", with no module state', () => {
    const a = seededStore();
    const b = seededStore();
    addNote(a, 'nur bei a');
    assert.equal(a.canUndo(), true);
    assert.equal(b.canUndo(), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Settings are outside history (5.4, rule U6)
// ═════════════════════════════════════════════════════════════════════════════

describe('settings and `pref` are never undoable (rule U6)', () => {
  test('setSettings records no undo step and does not clear a pending redo branch', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.undo();
    assert.equal(s.canRedo(), true);
    s.setSettings({ paper: 'a3' });
    s.setSettings({ rowHeight: 30 });
    assert.deepEqual(s.stacks.size(), { undo: 0, redo: 1 }, 'configuration is not a history event');
    s.redo();
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.state.settings.paper, 'a3', 'and the settings stayed forward');
  });

  test('`lastCategoryId` written INSIDE a transaction survives ⌘Z (4.2, recon B5)', () => {
    // interact.js:546 sets settings.lastCategoryId in the middle of create-note precisely so the
    // "last used category" is not dragged backwards by an undo. v1 gets that from CONTENT_KEYS;
    // v2 gets it from `pref.set` carrying no gid.
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => {
      tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT2, repeatsYearly: false, visibility: 'privat', coEdit: false });
      tx.pref({ lastCategoryId: CAT2 });
    });
    assert.equal(s.state.settings.lastCategoryId, CAT2);
    s.undo();
    assert.deepEqual(s.state.notes, []);
    assert.equal(s.state.settings.lastCategoryId, CAT2, 'settings stayed forward');
  });

  test('a transaction that writes ONLY a pref records no step and keeps the redo branch', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.undo();
    s.txn('recategorise', (tx) => tx.pref({ lastCategoryId: CAT1 }));
    assert.deepEqual(s.stacks.size(), { undo: 0, redo: 1 });
  });

  test('a `pref.set` op carries a null gid and lives in the local space', () => {
    const s = seededStore();
    s.txn('p', (tx) => tx.pref({ layers: { feiertage: false } }));
    const op = s.emitted.at(-1);
    assert.equal(op.k, 'pref.set');
    assert.equal(op.gid, null);
    assert.equal(op.space, LOCAL_SPACE);
    assert.deepEqual(op.f, { 'layers.feiertage': false });
    assert.equal(s.state.settings.layers.feiertage, false);
  });

  test('push() refuses to record a pref triple even if one is handed to it directly', () => {
    const stacks = createUndoStacks({ act: MEM_ME, dev: DEV_A, mint: () => fmt(T0, 0, DS_A), shadow: false });
    assert.equal(stacks.push(b22(), 'x', [[PREF_KEY, 'lastCategoryId', CAT1]], [[PREF_KEY, 'lastCategoryId', CAT2]]), false);
    assert.equal(stacks.canUndo(), false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The transaction builder (ops.contract.js §7's `Tx`)
// ═════════════════════════════════════════════════════════════════════════════

describe('makeTx', () => {
  test('get() reads the current values the v1 sites branch on', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('read', (tx) => {
      assert.equal(tx.get('note', id).text, 'x');
      assert.equal(tx.get('note', 'nope'), undefined);
      assert.equal(tx.get('cat', CAT1).name, 'Arbeit');
      assert.equal(tx.get('pad', '2099-01'), undefined);
      return false;
    });
    assert.throws(() => s.txn('bad', (tx) => tx.get('member', 'x')), UndoError);
  });

  test('the v1 decline protocol survives verbatim: `return false` before any builder call', () => {
    const s = seededStore();
    const r = s.txn('move-note', (tx) => {
      const n = tx.get('note', 'does-not-exist');
      if (!n) return false;
      tx.note('does-not-exist').set({ date: '2026-01-01' });
      return true;
    });
    assert.equal(r, false);
    assert.equal(s.emitted.length, 2, 'only the two seeded category ops exist');
    assert.equal(s.canUndo(), false);
  });

  test('set() refuses `_born` — it is write-once and belongs to create()', () => {
    const s = seededStore();
    assert.throws(
      () => s.txn('x', (tx) => tx.note(uuid()).set({ _born: fmt(T0, 0, DS_A) })),
      (e) => e instanceof UndoError && /write-once/.test(e.message),
    );
  });

  test('create() stamps `_born` from the op\'s own stamp and defaults `_alive` to true', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT1 }));
    const op = s.emitted.at(-1);
    assert.equal(op.f._born, op.ts, 'createdAt is derived from the create op\'s own stamp (§1.4)');
    assert.equal(op.f._alive, true);
  });

  test('ensureVisible() is v1\'s logic, inside the same group so it is one ⌘Z (4.6)', () => {
    const s = seededStore();
    s.txn('hide', (tx) => tx.cat(CAT1).set({ visible: false }));
    const id = uuid();
    s.txn('create-note', (tx) => {
      assert.equal(tx.ensureVisible(CAT1), true, 'hidden → it unhides and says so');
      assert.equal(tx.ensureVisible(CAT2), false, 'already visible → v1 returns false');
      assert.equal(tx.ensureVisible('no-such-cat'), false, 'unknown → v1 returns false');
      tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false });
    });
    assert.equal(s.state.categories.find((c) => c.id === CAT1).visible, true);
    assert.equal(s.state.notes.length, 1);
    s.undo();
    assert.deepEqual(s.state.notes, [], 'one ⌘Z');
    assert.equal(s.state.categories.find((c) => c.id === CAT1).visible, false, 'and the unhide came back with it');
  });

  test('all 22 v1 mutations produce op sets this transaction model can invert', () => {
    // MUTATIONS maps each user gesture onto the field assignments it really is. Every one of its
    // op sets must round-trip through captureImages/opsFromImage, or the corresponding gesture
    // would have a broken ⌘Z after WP-3.
    // (The sentence above is worded to avoid the two words f-r-o-m and a quote on one line:
    //  suite-integrity.test.js greps tier-1 test files for import specifiers with a plain regex
    //  and a quoted phrase after that word reads as an illegal import. Do not "tidy" this back.)
    const names = Object.keys(MUTATIONS);
    assert.equal(names.length, 22, `expected 22 v1 mutate sites, found ${names.length}`);
    const mint = (() => { let i = 0; return () => fmt(T0, i++, DS_A); })();
    const ctx = { act: MEM_ME, dev: DEV_A, gid: b22(), mint, newOpId: () => b22(), space: PERSONAL_PLACEHOLDER };
    const nid = uuid(); const bid = uuid(); const cid = uuid();
    const args = {
      deleteSelected: { type: 'note', id: nid },
      createBar: { id: bid, startDate: '2026-01-01', endDate: '2026-01-05', categoryId: CAT1, unhideCategoryId: CAT1 },
      moveNote: { id: nid, date: '2026-02-02' },
      moveBar: { id: bid, startDate: '2026-02-02', endDate: '2026-02-06' },
      resizeBar: { id: bid, endDate: '2026-02-09' },
      createNoteInline: { id: nid, date: '2026-01-01', text: 'x', categoryId: CAT1, lastCategoryId: CAT1 },
      editNoteInline: { id: nid, text: 'y', categoryId: CAT2, lastCategoryId: CAT2 },
      editBarLabel: { id: bid, label: 'L' },
      padTyping: { month: '2026-03', text: 'hallo', born: true },
      padBlur: { month: '2026-03', text: '' },
      createNotePopover: { id: nid, date: '2026-01-01', text: 'x', categoryId: CAT1 },
      recategoriseNote: { id: nid, categoryId: CAT2 },
      toggleRepeat: { id: nid, repeatsYearly: true, date: '2026-01-01' },
      deleteNotePopover: { id: nid },
      recategoriseBar: { id: bid, categoryId: CAT2 },
      editNotePopover: { id: nid, text: 'z' },
      toggleCategory: { id: cid, visible: false },
      addCategory: { id: cid, name: 'Neu', nameEn: 'New', paletteRef: 'rot' },
      renameCategory: { id: cid, lang: 'de', name: 'Umbenannt' },
      recolorCategory: { id: cid, paletteRef: 'gelb' },
      deleteCategory: { id: cid, lastCategoryId: CAT1 },
      deleteCategoryReassign: { id: cid, targetId: CAT1, noteIds: [nid], barIds: [bid], lastCategoryId: CAT1 },
    };
    for (const name of names) {
      const ops = MUTATIONS[name].build(ctx, args[name]);
      const { pre, post } = captureImages(new Map(), ops, { me: MEM_ME });
      assert.ok(pre.length > 0, `${name} produced no undoable pre-image`);
      const inv = opsFromImage({ ...ctx, gid: b22() }, pre);
      const fwd = opsFromImage({ ...ctx, gid: b22() }, post);
      for (const op of [...inv, ...fwd]) {
        assert.deepEqual(validateOp(op), { ok: true }, `${name} → invalid inverse op ${JSON.stringify(op)}`);
        assert.ok(!('_born' in op.f), `${name} → an inverse op wrote _born`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. opsFromImage — the guards
// ═════════════════════════════════════════════════════════════════════════════

describe('opsFromImage', () => {
  const ctx = () => ({ act: MEM_ME, dev: DEV_A, gid: b22(), mint: (() => { let i = 0; return () => fmt(T0, i++, DS_A); })(), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER });

  test('picks the op kind from the entity key', () => {
    const ops = opsFromImage(ctx(), [
      [noteKey(uuid()), 'date', '2026-01-01'],
      [barKey(uuid()), 'label', 'L'],
      [catKey(uuid()), 'visible', true],
      [padKey('2026-04'), 'text', 't'],
    ]);
    assert.deepEqual(ops.map((o) => o.k), ['note.set', 'bar.set', 'cat.set', 'pad.set']);
    for (const o of ops) assert.equal(opKindForEntity(kindOfEntity(o.e)), o.k);
  });

  test('refuses a non-undoable entity and refuses `_born`', () => {
    assert.throws(() => opsFromImage(ctx(), [[PREF_KEY, 'x', 1]]), UndoError);
    assert.throws(() => opsFromImage(ctx(), [[familyKey('fnote', MEM_ME, uuid()), 'pub.text', 'x']]), UndoError);
    assert.throws(() => opsFromImage(ctx(), [[noteKey(uuid()), '_born', fmt(T0, 0, DS_A)]]), UndoError);
  });

  test('merges the triples of one entity into one op, in field order', () => {
    const id = uuid();
    const ops = opsFromImage(ctx(), [[noteKey(id), 'date', '2026-01-01'], [noteKey(id), 'text', 'x']]);
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0].f, { date: '2026-01-01', text: 'x' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Sync hazards — reorder, duplicate, interleave, partition
// ═════════════════════════════════════════════════════════════════════════════

function shuffled(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('undo under sync hazards', () => {
  /** A log containing a create, an edit, an undo and a redo — every op this module can emit. */
  function busyLog() {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-05-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('edit-note', (tx) => tx.note(id).set({ text: 'b' }));
    s.undo();
    s.txn('move-note', (tx) => tx.note(id).set({ date: '2026-05-09' }));
    s.txn('delete-note', (tx) => tx.note(id).del());
    s.undo();
    return { s, id, log: s.emitted };
  }

  test('the fold of a log containing undo ops is REORDER-invariant (20 shuffles)', () => {
    const { s, log } = busyLog();
    const expected = dumpRegs(s.regs);
    const rng = mulberry32(4242);
    for (let i = 0; i < 20; i++) {
      const regs = new Map();
      for (const op of shuffled(rng, log)) refFold(regs, op);
      assert.equal(dumpRegs(regs), expected, `shuffle ${i} diverged`);
    }
  });

  test('DUPLICATE delivery of an undo op changes nothing (idempotence)', () => {
    const { s, log } = busyLog();
    const expected = dumpRegs(s.regs);
    const regs = new Map();
    for (const op of log) { refFold(regs, op); refFold(regs, op); refFold(regs, op); }
    assert.equal(dumpRegs(regs), expected);
    // and re-delivering just the inverse ops to the live store is a no-op
    const stateBefore = JSON.stringify(s.state);
    s.applyRemote(log);
    assert.equal(JSON.stringify(s.state), stateBefore);
  });

  test('an old op arriving AFTER my undo cannot resurrect the undone value (monotone reads)', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-06-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('edit-note', (tx) => tx.note(id).set({ text: 'b' }));
    s.undo();
    assert.equal(s.state.notes[0].text, 'a');
    // A three-weeks-late op from a peer, stamped BEFORE my undo.
    const late = makeOp(
      { act: MEM_MAMA, dev: DEV_B, gid: b22(), mint: () => fmt(T0 - 1000, 0, DS_B), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER },
      'note.set', noteKey(id), { text: 'sehr alt' },
    );
    s.applyRemote([late]);
    assert.equal(s.state.notes[0].text, 'a', 'the older stamp loses; the undo stands');
  });

  test('an undo can legitimately LOSE to a change that arrives afterwards (rule U4)', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-06-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('edit-note', (tx) => tx.note(id).set({ text: 'b' }));
    s.undo();
    s.wall.advance(5000);
    const newer = makeOp(
      { act: MEM_MAMA, dev: DEV_B, gid: b22(), mint: () => fmt(T0 + 4000, 0, DS_B), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER },
      'note.set', noteKey(id), { text: 'von Mama, danach' },
    );
    s.applyRemote([newer]);
    assert.equal(s.state.notes[0].text, 'von Mama, danach');
    assert.equal(s.canRedo(), true, 'and my redo branch is untouched by losing');
  });

  test('my undo only writes the fields MY transaction wrote — a peer\'s other field survives', () => {
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-07-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('move-note', (tx) => tx.note(id).set({ date: '2026-07-15' }));
    s.wall.advance(1000);
    const peerEdit = makeOp(
      { act: MEM_MAMA, dev: DEV_B, gid: b22(), mint: () => fmt(T0 + 900, 0, DS_B), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER },
      'note.set', noteKey(id), { text: 'von Mama' },
    );
    s.applyRemote([peerEdit]);
    s.undo();
    assert.equal(s.state.notes[0].date, '2026-07-01', 'my move was undone');
    assert.equal(s.state.notes[0].text, 'von Mama', 'her concurrent edit of another field survived');
  });

  test('18.6 — undo of my delete resurrects against a peer\'s newer delete, keeping newest content', () => {
    const me = seededStore();
    const id = uuid();
    me.txn('create-note', (tx) => tx.note(id).create({ date: '2026-08-01', text: 'Kino', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));

    const peerCtx = (ms) => ({ act: MEM_MAMA, dev: DEV_B, gid: b22(), mint: () => fmt(ms, 0, DS_B), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER });
    const peerEdit = makeOp(peerCtx(T0 + 100), 'note.set', noteKey(id), { text: 'Kino, 20 Uhr' });
    const peerDelete = makeOp(peerCtx(T0 + 200), 'note.set', noteKey(id), { _alive: false });

    me.txn('delete-note', (tx) => tx.note(id).del());
    me.wall.advance(1000);
    me.applyRemote([peerEdit, peerDelete]);
    assert.deepEqual(me.state.notes, [], 'both deletes agree');

    me.undo();
    assert.equal(me.state.notes.length, 1, 'a NEW op on the SAME entity, so it resurrects');
    assert.equal(me.state.notes[0].id, id, 'not a duplicate under a new id');
    assert.equal(me.state.notes[0].text, 'Kino, 20 Uhr', 'and it brings back the NEWEST content');
  });

  test('PARTITION and heal: both devices converge, and neither one\'s undo is lost', () => {
    // Me and my other Mac, offline from each other. I create, edit and undo the edit; the other
    // device moves the same note. On heal, per-field LWW: my text-undo wins on `text`, its move
    // wins on `date`, and the two register maps are byte-identical.
    const idA = uuid();
    const a = seededStore({ seed: 21 });
    a.txn('create-note', (tx) => tx.note(idA).create({ date: '2026-09-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));

    const b = new TestStore({ act: MEM_ME, dev: DEV_B, deviceShort: DS_B, seed: 22, wall: fakeClock(T0) });
    b.applyRemote(a.emitted);                       // both start from the same board
    const partitionMark = { a: a.emitted.length, b: b.emitted.length };

    a.wall.advance(10);
    a.txn('edit-note', (tx) => tx.note(idA).set({ text: 'a2' }));
    a.undo();

    b.wall.advance(20);
    b.txn('move-note', (tx) => tx.note(idA).set({ date: '2026-09-20' }));

    a.applyRemote(b.emitted.slice(partitionMark.b));
    b.applyRemote(a.emitted.slice(partitionMark.a));

    assert.equal(dumpRegs(a.regs), dumpRegs(b.regs), 'the partition healed to identical registers');
    assert.equal(a.state.notes[0].text, 'a');
    assert.equal(a.state.notes[0].date, '2026-09-20');
    assert.deepEqual(a.state, b.state);
    assert.equal(a.canRedo(), true, 'my redo branch survived the heal');
    assert.equal(b.canUndo(), true, 'and the other device still has its own step');
  });

  test('INTERLEAVED delivery of two devices\' undo streams converges to one state', () => {
    const rng = mulberry32(777);
    const ids = [uuid(), uuid()];
    const a = seededStore({ seed: 31 });
    const b = new TestStore({ act: MEM_ME, dev: DEV_B, deviceShort: DS_B, seed: 32, wall: fakeClock(T0) });
    a.txn('c1', (tx) => tx.note(ids[0]).create({ date: '2026-10-01', text: 'a1', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    b.applyRemote(a.emitted);
    for (let i = 0; i < 6; i++) {
      a.wall.advance(7); b.wall.advance(11);
      a.txn(`ea${i}`, (tx) => tx.note(ids[0]).set({ text: `a${i}` }));
      b.txn(`eb${i}`, (tx) => tx.note(ids[0]).set({ date: `2026-10-${String(i + 2).padStart(2, '0')}` }));
      if (i % 2 === 0) a.undo();
      if (i % 3 === 0) b.undo();
    }
    const all = [...a.emitted, ...b.emitted];
    for (const order of [all, shuffled(rng, all), shuffled(rng, all)]) {
      const regs = new Map();
      for (const op of order) refFold(regs, op);
      const regsDup = new Map();
      for (const op of [...order, ...shuffled(rng, order).slice(0, 10)]) refFold(regsDup, op);
      assert.equal(dumpRegs(regs), dumpRegs(regsDup), 'duplicates changed the outcome');
    }
    const merged = new Map();
    for (const op of shuffled(rng, all)) refFold(merged, op);
    const merged2 = new Map();
    for (const op of shuffled(rng, all)) refFold(merged2, op);
    assert.equal(dumpRegs(merged), dumpRegs(merged2));
  });

  test('a fan-out group half-delivered leaves a consistent board that converges (ADR 001 §6)', () => {
    const a = seededStore({ seed: 41 });
    const n1 = uuid(); const n2 = uuid();
    a.txn('c', (tx) => {
      tx.note(n1).create({ date: '2026-11-01', text: 'n1', categoryId: CAT2, repeatsYearly: false, visibility: 'privat', coEdit: false });
      tx.note(n2).create({ date: '2026-11-02', text: 'n2', categoryId: CAT2, repeatsYearly: false, visibility: 'privat', coEdit: false });
    });
    a.txn('delete-category', (tx) => {
      tx.note(n1).set({ categoryId: CAT1 });
      tx.note(n2).set({ categoryId: CAT1 });
      tx.cat(CAT2).del();
    });
    const before = a.emitted.length;
    a.undo();
    const inverse = a.emitted.slice(before);
    assert.equal(inverse.length, 3, 'N+1 register writes, one group, one ⌘Z');

    const partial = new Map();
    for (const op of a.emitted.slice(0, before)) refFold(partial, op);
    for (const op of inverse.slice(0, 2)) refFold(partial, op);          // half the undo arrives
    const half = refMaterialize(partial);
    assert.equal(half.notes.every((n) => n.categoryId === CAT2), true, 'consistent, if half-done');
    for (const op of inverse.slice(2)) refFold(partial, op);
    assert.equal(dumpRegs(partial), dumpRegs(a.regs), 'and it converges when the rest arrives');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. The shadow-undo assertion (ADR 001 §7.1, PLAN risk R5)
// ═════════════════════════════════════════════════════════════════════════════

describe('shadow-undo assertion', () => {
  test('DEV is on for this whole file and arms the assertion by default', () => {
    assert.equal(DEV, true, 'ADR 001 §7.1: the whole tier-1 suite runs with it on');
    const s = seededStore();
    assert.equal(s.stacks.shadowArmed, true);
  });

  test('shadowContent clones exactly v1\'s four content keys, and settings are absent', () => {
    const s = seededStore();
    s.setSettings({ paper: 'a3' });
    const snap = shadowContent(s.state);
    assert.deepEqual(Object.keys(snap).sort(), ['bars', 'categories', 'notes', 'scratchpads']);
    assert.equal('settings' in snap, false, 'settings are configuration, not board content (5.4)');
    snap.categories[0].name = 'mutiert';
    assert.equal(s.state.categories[0].name, 'Arbeit', 'it is a deep clone');
  });

  test('shadowContent reduces to the v1 shape: no v2 decoration, no foreign entries', () => {
    // The assertion claims "the op-log undo agrees with V1's snapshot undo", so it compares v1
    // fields. `updatedAt` is derived from the register stamps and MUST move on every undo — the
    // undo emits fresh ops — so comparing it would make the guard fire on correct behaviour.
    const snap = shadowContent({
      notes: [
        { id: 'n1', date: '2026-01-01', text: 'mine', categoryId: CAT1, _born: fmt(T0, 0, DS_A), updatedAt: fmt(T0, 9, DS_A), updatedBy: MEM_ME, isForeign: false, visibility: 'privat' },
        { id: 'n2', date: '2026-01-02', text: 'hers', isForeign: true, ownerId: MEM_MAMA },
      ],
      bars: [],
      categories: [{ id: CAT1, name: 'Arbeit', paletteRef: 'blau', visible: true, defaultVisibility: 'privat', _born: fmt(T0, 1, DS_A) }],
      scratchpads: { '2026-01': 'x' },
    });
    assert.equal(snap.notes.length, 1, 'a foreign entry has no v1 counterpart and is dropped');
    assert.deepEqual(Object.keys(snap.notes[0]).sort(), ['categoryId', 'date', 'id', 'text']);
    assert.deepEqual(Object.keys(snap.categories[0]).sort(), ['id', 'name', 'paletteRef', 'visible']);
    for (const f of V2_ENTRY_FIELDS) assert.equal(f in snap.notes[0], false, `${f} leaked into the shadow`);
  });

  test('v2-only registers are outside the shadow\'s remit, so they get a direct test', () => {
    // `visibility` and `coEdit` are stripped from the shadow comparison because v1 has no
    // opinion about them. They are still ordinary registers and ⌘Z must restore them.
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('share', (tx) => tx.note(id).set({ visibility: 'geteilt', coEdit: true }));
    assert.equal(readRegister(s.regs, noteKey(id), 'visibility').value, 'geteilt');
    s.undo();
    assert.equal(readRegister(s.regs, noteKey(id), 'visibility').value, 'privat');
    assert.equal(readRegister(s.regs, noteKey(id), 'coEdit').value, false);
    s.redo();
    assert.equal(readRegister(s.regs, noteKey(id), 'visibility').value, 'geteilt');
    assert.equal(readRegister(s.regs, noteKey(id), 'coEdit').value, true);
  });

  test('push() refuses a transaction that captured no shadow while armed', () => {
    const stacks = createUndoStacks({ act: MEM_ME, dev: DEV_A, mint: () => fmt(T0, 0, DS_A), shadow: true });
    assert.throws(
      () => stacks.push(b22(), 'x', [[noteKey(uuid()), 'text', 'a']], [[noteKey(uuid()), 'text', 'b']]),
      (e) => e instanceof UndoError && /shadow/.test(e.message),
    );
  });

  test('undo() refuses to run without the current state while armed', () => {
    const stacks = createUndoStacks({ act: MEM_ME, dev: DEV_A, mint: () => fmt(T0, 0, DS_A), shadow: true });
    const id = noteKey(uuid());
    stacks.push(b22(), 'x', [[id, 'text', 'a']], [[id, 'text', 'b']], shadowContent({ notes: [], bars: [], categories: [], scratchpads: {} }));
    assert.throws(() => stacks.undo(), (e) => e instanceof UndoError && /shadow/.test(e.message));
  });

  test('with the assertion disarmed the stacks work without any state at all', () => {
    const stacks = createUndoStacks({ act: MEM_ME, dev: DEV_A, mint: (() => { let i = 0; return () => fmt(T0, i++, DS_A); })(), newOpId: () => b22(), newGid: () => b22(), shadow: false });
    const e = noteKey(uuid());
    assert.equal(stacks.push(b22(), 'x', [[e, 'text', 'a']], [[e, 'text', 'b']]), true);
    const ops = stacks.undo();
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0].f, { text: 'a' });
    assert.equal(stacks.verify({ notes: [], bars: [], categories: [], scratchpads: {} }), false, 'nothing armed to check');
  });

  test('NEGATIVE CONTROL — a pre-image capturing the WRONG value is caught, not shipped', () => {
    // Without this the assertion could be vacuous and nobody would know. Capturing a wrong
    // pre-value is the shape of the bug the guard exists for: a mutate site whose op set does not
    // describe everything it changed leaves the register the undo restores holding a value the
    // v1-style snapshot disagrees with.
    const s = seededStore({
      sabotage: (pre) => pre.map((t) => (t[1] === 'date' ? [t[0], t[1], '1999-12-31'] : t)),
    });
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('move-note', (tx) => tx.note(id).set({ date: '2026-02-02' }));
    assert.throws(() => s.undo(), (e) => {
      assert.ok(e instanceof ShadowUndoError, `expected ShadowUndoError, got ${e}`);
      assert.match(e.message, /move-note/);
      assert.match(e.detail.difference, /date/);
      assert.equal(e.detail.direction, 'undo');
      return true;
    });
  });

  test('NEGATIVE CONTROL — an inverse of a create that fails to tombstone is caught', () => {
    // The create rule's other half. If `{_alive:false}` were ever emitted as `{_alive:true}` —
    // or simply omitted — the note would still be on the board after ⌘Z and no op-log invariant
    // would notice, because the register map would be perfectly self-consistent.
    const s = seededStore({
      sabotage: (pre) => pre.map((t) => (t[1] === '_alive' ? [t[0], t[1], true] : t)),
    });
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    assert.throws(() => s.undo(), (e) => {
      assert.ok(e instanceof ShadowUndoError, `expected ShadowUndoError, got ${e}`);
      assert.match(e.detail.difference, /notes\.length: 0 vs 1/);
      return true;
    });
  });

  test('a remote op retires the whole-content expectation without touching either stack', () => {
    // The assertion is a SOLO equivalence check (ADR 001 §7.1's own theorem says "no remote
    // ops"). Restoring my `date` while a peer's concurrent edit of the same note's `text`
    // survives is correct behaviour (18.5) and must not read as a shadow mismatch.
    const s = seededStore();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-01-01', text: 'a', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('move-note', (tx) => tx.note(id).set({ date: '2026-02-02' }));
    const before = { size: s.stacks.size(), labels: s.stacks.labels(), top: s.stacks.peekUndo() };
    s.wall.advance(1000);
    s.applyRemote([makeOp(
      { act: MEM_MAMA, dev: DEV_B, gid: b22(), mint: () => fmt(T0 + 900, 0, DS_B), newOpId: () => b22(), space: PERSONAL_PLACEHOLDER },
      'note.set', noteKey(id), { text: 'von Mama' },
    )]);
    assert.deepEqual(s.stacks.size(), before.size, 'no entry created or removed');
    assert.deepEqual(s.stacks.labels(), before.labels, 'no entry reordered');
    assert.deepEqual(s.stacks.peekUndo(), before.top, 'the top entry is byte-for-byte the same');
    assert.doesNotThrow(() => s.undo());
    assert.equal(s.state.notes[0].date, '2026-01-01');
    assert.equal(s.state.notes[0].text, 'von Mama');
  });

  test('remoteApplied() is a strict no-op when the assertion is disarmed', () => {
    const stacks = createUndoStacks({ act: MEM_ME, dev: DEV_A, mint: (() => { let i = 0; return () => fmt(T0, i++, DS_A); })(), newOpId: () => b22(), newGid: () => b22(), shadow: false });
    const e = noteKey(uuid());
    stacks.push(b22(), 'x', [[e, 'text', 'a']], [[e, 'text', 'b']]);
    stacks.remoteApplied();
    assert.deepEqual(stacks.size(), { undo: 1, redo: 0 });
    assert.equal(stacks.undo().length, 1);
    assert.equal(stacks.canRedo(), true);
  });

  test('firstDifference names the exact path, and sameContent agrees with it', () => {
    assert.equal(firstDifference({ a: 1 }, { a: 1 }), null);
    assert.equal(sameContent({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.match(firstDifference({ a: [1, 2] }, { a: [1, 3] }), /\$\.a\[1\]: 2 vs 3/);
    assert.match(firstDifference({ a: 1 }, { a: 1, b: 2 }), /keys/);
    assert.match(firstDifference([1], [1, 2]), /length: 1 vs 2/);
    assert.match(firstDifference(null, {}), /null vs object/);
    assert.match(firstDifference('x', 1), /string vs number/);
    assert.equal(sameContent({ a: NaN }, { a: NaN }), true, 'NaN compares as itself');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Property P6 — a reference v1 snapshot-undo running BESIDE the op-log undo
// ═════════════════════════════════════════════════════════════════════════════

/**
 * v1's `store.js:147-191`, reimplemented over a plain content object. Deliberately the SNAPSHOT
 * design the op log replaces: whole-content clone in, whole-content clone out. If the two agree
 * after every step over thousands of random actions, the op-log undo reproduces v1's solo
 * semantics — which is LZP-402's acceptance criterion.
 */
class V1RefStore {
  constructor(limit = UNDO_LIMIT) {
    this.content = { notes: [], bars: [], categories: [], scratchpads: {} };
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
  }
  _clone() { return structuredClone(this.content); }
  mutate(fn) {
    const before = this._clone();
    const r = fn(this.content);
    if (r === false) return r;
    this.undoStack.push(before);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    return r;
  }
  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.redoStack.push(this._clone());
    this.content = snap;
    return true;
  }
  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push(this._clone());
    this.content = snap;
    return true;
  }
}

/** The action alphabet, each written twice: once in ops, once as a v1 in-place mutation. */
function buildActions(rng) {
  const TEXTS = ['Zahnarzt', 'Kino', 'Elternabend', 'Umzug', 'Urlaub', ''];
  const REFS = ['blau', 'gruen', 'orange', 'magenta', 'tuerkis'];
  const DATES = ['2026-01-05', '2026-03-17', '2026-06-30', '2026-09-08', '2026-12-24'];
  const MONTHS = ['2026-02', '2026-07', '2026-11'];
  return { TEXTS, REFS, DATES, MONTHS, rng };
}

describe('P6 — op-log undo vs a reference v1 snapshot undo, compared after EVERY step', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    test(`seed ${seed}: 220 random actions stay in lock-step`, () => {
      const rng = mulberry32(seed);
      const A = buildActions(rng);
      const s = seededStore({ seed });
      const ref = new V1RefStore();
      ref.content.categories = s.state.categories.map(normCat);

      let undoSteps = 0; let redoSteps = 0; let stepNo = -1;

      /** The whole point of P6: the two implementations are compared after EVERY move. */
      const compare = (what) => {
        const mine = normContent(s.state);
        const theirs = {
          notes: sortNotes(ref.content.notes).map(normNote),
          bars: sortBars(ref.content.bars).map(normBar),
          categories: sortCategories(ref.content.categories).map(normCat),
          scratchpads: sortScratchpads(ref.content.scratchpads),
        };
        const diff = firstDifference(theirs, mine);
        assert.equal(diff, null, `seed ${seed}, step ${stepNo} (${what}): op-log undo and v1 snapshot undo disagree at ${diff}`);
        assert.equal(s.canUndo(), ref.undoStack.length > 0, `seed ${seed}, step ${stepNo} (${what}): canUndo diverged`);
        assert.equal(s.canRedo(), ref.redoStack.length > 0, `seed ${seed}, step ${stepNo} (${what}): canRedo diverged`);
      };

      const liveNotes = () => s.state.notes.map((n) => n.id);
      const liveBars = () => s.state.bars.map((b) => b.id);
      const liveCats = () => s.state.categories.map((c) => c.id);

      /** run the same user action through both implementations */
      const both = (opFn, refFn) => { s.txn('act', opFn); ref.mutate(refFn); };

      const step = () => {
        const roll = rng();
        const nIds = liveNotes(); const bIds = liveBars(); const cIds = liveCats();

        if (roll < 0.20 || (nIds.length === 0 && roll < 0.35)) {
          const id = uuid(); const date = pick(rng, A.DATES); const cat = pick(rng, cIds);
          const text = pick(rng, A.TEXTS) || 'x';
          both(
            (tx) => { tx.ensureVisible(cat); tx.note(id).create({ date, text, categoryId: cat, repeatsYearly: false, visibility: 'privat', coEdit: false }); },
            (c) => {
              const k = c.categories.find((x) => x.id === cat);
              if (k && k.visible === false) k.visible = true;
              c.notes.push({ id, date, text, categoryId: cat, repeatsYearly: false });
            },
          );
        } else if (roll < 0.30 && nIds.length) {
          const id = pick(rng, nIds); const text = pick(rng, A.TEXTS);
          if (text === '') {
            both((tx) => tx.note(id).del(), (c) => { c.notes = c.notes.filter((n) => n.id !== id); });
          } else {
            both((tx) => tx.note(id).set({ text }), (c) => { c.notes.find((n) => n.id === id).text = text; });
          }
        } else if (roll < 0.38 && nIds.length) {
          const id = pick(rng, nIds); const date = pick(rng, A.DATES);
          both((tx) => tx.note(id).set({ date }), (c) => { c.notes.find((n) => n.id === id).date = date; });
        } else if (roll < 0.43 && nIds.length) {
          const id = pick(rng, nIds); const on = rng() < 0.5;
          const date = pick(rng, A.DATES);
          both(
            (tx) => tx.note(id).set(on ? { repeatsYearly: true, date } : { repeatsYearly: false }),
            (c) => { const n = c.notes.find((x) => x.id === id); n.repeatsYearly = on; if (on) n.date = date; },
          );
        } else if (roll < 0.48 && nIds.length) {
          const id = pick(rng, nIds); const cat = pick(rng, cIds);
          both((tx) => tx.note(id).set({ categoryId: cat }), (c) => { c.notes.find((n) => n.id === id).categoryId = cat; });
        } else if (roll < 0.55) {
          const id = uuid(); const i = Math.floor(rng() * (A.DATES.length - 1));
          const startDate = A.DATES[i]; const endDate = A.DATES[i + 1]; const cat = pick(rng, cIds);
          both(
            (tx) => tx.bar(id).create({ startDate, endDate, label: '', categoryId: cat, visibility: 'privat', coEdit: false }),
            (c) => { c.bars.push({ id, startDate, endDate, label: '', categoryId: cat }); },
          );
        } else if (roll < 0.62 && bIds.length) {
          const id = pick(rng, bIds); const label = pick(rng, A.TEXTS);
          both((tx) => tx.bar(id).set({ label }), (c) => { c.bars.find((b) => b.id === id).label = label; });
        } else if (roll < 0.67 && bIds.length) {
          const id = pick(rng, bIds); const i = Math.floor(rng() * (A.DATES.length - 1));
          const startDate = A.DATES[i]; const endDate = A.DATES[i + 1];
          both(
            (tx) => tx.bar(id).set({ startDate, endDate }),
            (c) => { const b = c.bars.find((x) => x.id === id); b.startDate = startDate; b.endDate = endDate; },
          );
        } else if (roll < 0.70 && bIds.length) {
          const id = pick(rng, bIds);
          both((tx) => tx.bar(id).del(), (c) => { c.bars = c.bars.filter((b) => b.id !== id); });
        } else if (roll < 0.74) {
          const id = uuid(); const name = `Kat${Math.floor(rng() * 1000)}`; const ref2 = pick(rng, A.REFS);
          both(
            (tx) => tx.cat(id).create({ name, nameEn: name, paletteRef: ref2, visible: true, defaultVisibility: 'privat' }),
            (c) => { c.categories.push({ id, name, nameEn: name, paletteRef: ref2, visible: true }); },
          );
        } else if (roll < 0.78) {
          const id = pick(rng, cIds); const name = `Neu${Math.floor(rng() * 1000)}`;
          both(
            (tx) => tx.cat(id).set({ name, nameEn: null }),
            (c) => { const k = c.categories.find((x) => x.id === id); k.name = name; delete k.nameEn; },
          );
        } else if (roll < 0.81) {
          const id = pick(rng, cIds); const ref2 = pick(rng, A.REFS);
          both((tx) => tx.cat(id).set({ paletteRef: ref2 }), (c) => { c.categories.find((x) => x.id === id).paletteRef = ref2; });
        } else if (roll < 0.84) {
          const id = pick(rng, cIds);
          const now = s.state.categories.find((c) => c.id === id).visible !== false;
          both((tx) => tx.cat(id).set({ visible: !now }), (c) => { c.categories.find((x) => x.id === id).visible = !now; });
        } else if (roll < 0.88 && cIds.length > 1) {
          // delete-with-reassign — the N+M+1 fan-out, one gid, one ⌘Z
          const id = pick(rng, cIds);
          const target = cIds.find((c) => c !== id);
          const noteIds = s.state.notes.filter((n) => n.categoryId === id).map((n) => n.id);
          const barIds = s.state.bars.filter((b) => b.categoryId === id).map((b) => b.id);
          both(
            (tx) => {
              for (const nid of noteIds) tx.note(nid).set({ categoryId: target });
              for (const bid of barIds) tx.bar(bid).set({ categoryId: target });
              tx.cat(id).del();
            },
            (c) => {
              for (const n of c.notes) if (n.categoryId === id) n.categoryId = target;
              for (const b of c.bars) if (b.categoryId === id) b.categoryId = target;
              c.categories = c.categories.filter((x) => x.id !== id);
            },
          );
        } else if (roll < 0.92) {
          const month = pick(rng, A.MONTHS); const text = pick(rng, A.TEXTS);
          if (text.trim()) {
            const exists = s.state.scratchpads[month] !== undefined;
            both(
              (tx) => (exists ? tx.pad(month).set({ text, _alive: true }) : tx.pad(month).create({ text })),
              (c) => { c.scratchpads[month] = text; },
            );
          } else {
            both((tx) => tx.pad(month).del(), (c) => { delete c.scratchpads[month]; });
          }
        } else if (roll < 0.94) {
          // configuration — must be invisible to BOTH histories
          s.setSettings({ rowHeight: 20 + Math.floor(rng() * 20) });
        } else {
          // A history BURST: several ⌘Z in a row, then some ⇧⌘Z. Bursts, not single moves,
          // because "undo three times then redo twice" is where a stack model actually drifts,
          // and both states are compared after every individual move.
          const nUndo = 1 + Math.floor(rng() * 3);
          for (let k = 0; k < nUndo; k++) {
            const moved = s.undo();
            assert.equal(moved, ref.undo(), 'undo availability diverged');
            if (moved) undoSteps++;
            compare(`undo ${k}`);
          }
          const nRedo = Math.floor(rng() * 3);
          for (let k = 0; k < nRedo; k++) {
            const moved = s.redo();
            assert.equal(moved, ref.redo(), 'redo availability diverged');
            if (moved) redoSteps++;
            compare(`redo ${k}`);
          }
        }
      };

      for (let i = 0; i < 220; i++) {
        stepNo = i;
        step();
        compare('action');
      }
      assert.ok(s.emitted.length > 200, 'the generator did not actually exercise the store');
      // Proof the assertion was not merely armed but actually CHECKING on every history move:
      // there are no remote ops in this scenario, so no expectation was ever retired.
      assert.equal(s.verified, undoSteps + redoSteps, 'a history move ran without a shadow check');
      assert.ok(s.verified > 20, `only ${s.verified} shadow checks ran — the generator barely used history`);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Guards on the module's own contract
// ═════════════════════════════════════════════════════════════════════════════

describe('createUndoStacks — configuration', () => {
  const base = { act: MEM_ME, dev: DEV_A, mint: () => fmt(T0, 0, DS_A), shadow: false };

  test('a missing or malformed configuration is a loud error, never a quiet default', () => {
    assert.throws(() => createUndoStacks({ ...base, mint: undefined }), (e) => e instanceof UndoError && /mint/.test(e.message));
    assert.throws(() => createUndoStacks({ ...base, act: 'nobody' }), (e) => e instanceof UndoError && /MemberId/.test(e.message));
    assert.throws(() => createUndoStacks({ ...base, dev: 'nothing' }), (e) => e instanceof UndoError && /DeviceId/.test(e.message));
    assert.throws(() => createUndoStacks({ ...base, limitGroups: 0 }), UndoError);
    assert.throws(() => createUndoStacks({ ...base, limitGroups: 2.5 }), UndoError);
  });

  test('limitGroups is honoured exactly', () => {
    const s = seededStore({ limitGroups: 3 });
    for (let i = 0; i < 5; i++) {
      const id = uuid();
      s.txn('n', (tx) => tx.note(id).create({ date: '2026-01-01', text: `n${i}`, categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    }
    assert.deepEqual(s.stacks.size(), { undo: 3, redo: 0 });
    let steps = 0; while (s.undo()) steps++;
    assert.equal(steps, 3);
    assert.equal(s.state.notes.length, 2, 'the two oldest are beyond the horizon');
  });

  test('push() returns false for an empty image and true when it records', () => {
    const stacks = createUndoStacks(base);
    assert.equal(stacks.push(b22(), 'x', [], []), false);
    assert.equal(stacks.push(b22(), 'x', [[noteKey(uuid()), 'text', 'a']], []), true);
  });

  test('a malformed image triple is refused', () => {
    const stacks = createUndoStacks(base);
    assert.throws(() => stacks.push(b22(), 'x', [['note:x', 'text']], []), UndoError);
    assert.throws(() => stacks.push(b22(), 'x', ['not-a-triple'], []), UndoError);
  });

  test('`_born` triples are filtered out of an image handed straight to push()', () => {
    const stacks = createUndoStacks({ ...base, mint: (() => { let i = 0; return () => fmt(T0, i++, DS_A); })(), newOpId: () => b22(), newGid: () => b22() });
    const e = noteKey(uuid());
    stacks.push(b22(), 'x', [[e, '_born', fmt(T0, 0, DS_A)], [e, 'text', 'a']], [[e, 'text', 'b']]);
    const ops = stacks.undo();
    assert.deepEqual(ops[0].f, { text: 'a' }, '_born never reaches an inverse op');
  });

  test('shadowContent refuses a non-state argument rather than cloning junk', () => {
    assert.throws(() => shadowContent(null), UndoError);
    assert.throws(() => shadowContent('board'), UndoError);
  });

  test('there is no method that accepts an op, so the remote path cannot feed the stacks', () => {
    const stacks = createUndoStacks(base);
    const surface = Object.keys(stacks).sort();
    assert.deepEqual(surface, [
      'canRedo', 'canUndo', 'clear', 'labels', 'peekRedo', 'peekUndo',
      'push', 'redo', 'remoteApplied', 'shadowArmed', 'size', 'undo', 'verify',
    ]);
    assert.equal(typeof stacks.applyRemote, 'undefined');
    assert.equal(typeof stacks.append, 'undefined');
  });

  test('no undoable field on any kind is named like a relative change (ADR 001 §6)', () => {
    const RELATIVE = /delta|offset|shift|^by$|increment|adjust/i;
    for (const kind of UNDOABLE_KINDS) {
      for (const f of Object.keys(FIELDS[kind])) {
        assert.ok(!RELATIVE.test(f), `FIELDS.${kind}.${f} reads as a relative change`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Cross-check against the SHIPPING registers.js and materialize.js
//
// The harness above deliberately carries its own tiny fold and projection, because undo.js must
// not depend on either module (it reads a RegisterMap, which is a data shape, not an API) and
// because a property test needs a second opinion rather than the system agreeing with itself.
// But the retrofit will run undo against the real ones, so the same scenarios are replayed with
// `registers.applyOp` and `materialize` swapped in. Anything that passes here and fails there —
// a writeOnce rule, a projection that reads `_alive` differently — would be a WP-3 surprise.
// ═════════════════════════════════════════════════════════════════════════════

describe('cross-check — undo driven through registers.js + materialize.js', () => {
  const mk = (opts = {}) => seededStore({ ...opts, real: true });

  test('create → undo → redo, with the real fold and the real projection', () => {
    const s = mk();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-03-01', text: 'Kickoff', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.state.notes[0].text, 'Kickoff');
    s.undo();
    assert.deepEqual(s.state.notes, [], 'the real projection drops the tombstone too');
    s.redo();
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.state.notes[0].text, 'Kickoff', 'and the content registers were never cleared');
  });

  test('the real join does not let an inverse op rewrite `_born`', () => {
    const s = mk();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-03-01', text: 'x', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    const born = s.regs.get(noteKey(id)).get('_born').value;
    for (let i = 0; i < 4; i++) { s.undo(); s.redo(); }
    assert.equal(s.regs.get(noteKey(id)).get('_born').value, born);
    assert.equal(s.state.notes.length, 1);
  });

  test('delete → undo resurrects on the same key, through the real projection (18.6)', () => {
    const s = mk();
    const id = uuid();
    s.txn('create-note', (tx) => tx.note(id).create({ date: '2026-04-01', text: 'Impfung', categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    s.txn('delete-note', (tx) => tx.note(id).del());
    assert.deepEqual(s.state.notes, []);
    s.undo();
    assert.equal(s.state.notes.length, 1);
    assert.equal(s.state.notes[0].id, id);
  });

  test('a category delete-with-reassign fan-out is still one ⌘Z', () => {
    const s = mk();
    const n1 = uuid(); const n2 = uuid();
    s.txn('c', (tx) => {
      tx.note(n1).create({ date: '2026-05-01', text: 'a', categoryId: CAT2, repeatsYearly: false, visibility: 'privat', coEdit: false });
      tx.note(n2).create({ date: '2026-05-02', text: 'b', categoryId: CAT2, repeatsYearly: false, visibility: 'privat', coEdit: false });
    });
    s.txn('delete-category', (tx) => {
      tx.note(n1).set({ categoryId: CAT1 });
      tx.note(n2).set({ categoryId: CAT1 });
      tx.cat(CAT2).del();
    });
    assert.equal(s.state.categories.length, 1);
    assert.ok(s.state.notes.every((n) => n.categoryId === CAT1));
    s.undo();
    assert.equal(s.state.categories.length, 2);
    assert.ok(s.state.notes.every((n) => n.categoryId === CAT2));
    assert.equal(s.canUndo(), true, 'the create group is still below it');
  });

  test('the 50-group cap behaves identically on the real fold', () => {
    const s = mk();
    for (let i = 0; i < 60; i++) {
      const id = uuid();
      s.txn('n', (tx) => tx.note(id).create({ date: '2026-06-01', text: `n${i}`, categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
    }
    let steps = 0; while (s.undo()) steps++;
    assert.equal(steps, 50);
    assert.equal(s.state.notes.length, 10);
    assert.equal(s.state.notes.at(-1).text, 'n9');
  });

  test('scratchpad create/edit/clear round-trips through the real projection', () => {
    const s = mk();
    s.txn('pad', (tx) => tx.pad('2026-08').create({ text: 'Sommerfest' }));
    s.txn('pad', (tx) => tx.pad('2026-08').set({ text: 'Sommerfest, 15 Uhr' }));
    s.txn('pad', (tx) => tx.pad('2026-08').del());
    assert.equal(s.state.scratchpads['2026-08'], undefined);
    s.undo();
    assert.equal(s.state.scratchpads['2026-08'], 'Sommerfest, 15 Uhr');
    s.undo();
    assert.equal(s.state.scratchpads['2026-08'], 'Sommerfest');
    s.undo();
    assert.equal(s.state.scratchpads['2026-08'], undefined);
  });

  test('the two folds agree register for register over a random 150-action run', () => {
    // The strongest form of the cross-check: the same action stream, one store on the harness
    // fold and one on registers.js, must end with identical register maps AND identical boards.
    const rng = mulberry32(4711);
    const a = seededStore({ seed: 60 });
    const b = seededStore({ seed: 60, real: true });
    const ids = [];
    for (let i = 0; i < 150; i++) {
      const roll = rng();
      if (roll < 0.4 || ids.length === 0) {
        const id = uuid(); ids.push(id);
        const date = `2026-0${1 + Math.floor(rng() * 9)}-15`;
        for (const s of [a, b]) s.txn('c', (tx) => tx.note(id).create({ date, text: `t${i}`, categoryId: CAT1, repeatsYearly: false, visibility: 'privat', coEdit: false }));
      } else if (roll < 0.65) {
        const id = ids[Math.floor(rng() * ids.length)];
        for (const s of [a, b]) s.txn('e', (tx) => (tx.get('note', id) ? tx.note(id).set({ text: `x${i}` }) : false));
      } else if (roll < 0.75) {
        const id = ids[Math.floor(rng() * ids.length)];
        for (const s of [a, b]) s.txn('d', (tx) => (tx.get('note', id) ? tx.note(id).del() : false));
      } else if (roll < 0.9) {
        for (const s of [a, b]) s.undo();
      } else {
        for (const s of [a, b]) s.redo();
      }
      assert.equal(a.canUndo(), b.canUndo(), `step ${i}: canUndo diverged`);
      assert.equal(a.canRedo(), b.canRedo(), `step ${i}: canRedo diverged`);
      assert.equal(
        firstDifference(normContent(a.state), normContent(b.state)), null,
        `step ${i}: the harness fold and registers.js disagree`,
      );
    }
    assert.equal(dumpRegs(a.regs), dumpRegs(b.regs), 'register maps diverged');
    assert.ok(b.verified > 10, 'the shadow assertion ran on the real path too');
  });
});
