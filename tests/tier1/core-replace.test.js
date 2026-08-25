// tests/tier1/core-replace.test.js — ATT-40 · story 11.3, 11.5, 5.4, 19.4 · ADR 001 §8.5
//
// WHAT IS BEING GATED HERE.
// `replaceAllOps` is the primitive behind import (11.3) and snapshot restore (11.5). It was
// declared in `docs/v2/contracts/ops.contract.js`, specified in ADR 001 §8.5, CITED by
// `migrate1to2.js` — and implemented in no file at all (ATT-40). `src/js/core/replace.js` is that
// implementation, and this file is the evidence that it is the §8.5 DIFF TRANSACTION rather than
// the `board.reset` op the ADR rejects.
//
// The four properties the attack report demanded, each with its own describe block below:
//
//   A. THE LOG IS NOT REWOUND. An import is ordinary register writes at fresh stamps, so a paired
//      device converges TO the imported board instead of fighting it. Proved with two simulated
//      devices, in both delivery directions, and with the transaction split and reordered.
//   B. IT IS ONE UNDO GROUP, AND IT IS NOT UNDOABLE. Story 5.4 excludes import from undo and v1
//      implements that by clearing both stacks (`store.js:196-197`).
//   C. IT DOES NOT RESURRECT. An entity the incoming board does not have does not come back —
//      not from the local board, not from the peer, not by folding the transaction twice.
//   D. IT DOES NOT TOUCH ANOTHER MEMBER'S ENTITIES. This is the 19.4/11.5 convergence hole the
//      design review flagged: a blanket "kill everything the import does not have" over the whole
//      RegisterMap would blank the family's shared entries. Proved closed at three levels — the
//      emitted ops, the folded registers, and the projected board.
//
// Everything here drives the REAL core modules. There is no reference implementation in this
// file: `fold`, `materialize` and `classifyOp` are the shipping ones, so a test that passes here
// passes against the code the app runs.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CARRIED_FIELDS,
  IMPORT_DEFAULTS,
  PRESERVED_PREF_PREFIXES,
  REPLACEABLE_KINDS,
  REPLACE_ALL_LABEL,
  REPLACE_ALL_UNDOABLE,
  ReplaceError,
  planReplaceAll,
  replaceAllOps,
} from '../../src/js/core/replace.js';
import { migrateV1 } from '../../src/js/core/migrate1to2.js';
import { foldAll, cloneRegisters, getValue, hasRegister } from '../../src/js/core/registers.js';
import { materialize, stripV2Fields } from '../../src/js/core/materialize.js';
import { classifyOp, fieldsOf, LOCAL_SPACE, PERSONAL_PLACEHOLDER, pubSet } from '../../src/js/core/ops.js';
import { cmp, createClock } from '../../src/js/core/stamp.js';
import { parseEntityKey } from '../../src/js/core/entities.js';
import { store, defaultState } from '../../src/js/store.js';
import { note, bar } from '../helpers/fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('ME')}`;
const MAMA = `mem_${pad22('MAMA')}`;
const MAC_A = `dev_${pad22('MACA')}`;
const MAC_B = `dev_${pad22('MACB')}`;
const SHORT_A = 'MACA000000000000';
const SHORT_B = 'MACB000000000000';
const FSP = `fsp_${pad22('FAM')}`;
const PSP = `psp_${pad22('MINE')}`;
const BASE_MS = 1787836800000;                 // 2026-08-25T00:00:00Z, a fixed wall clock

const clone = (v) => structuredClone(v);
const j = (v) => JSON.stringify(v);

/** Deterministic op ids, so a failure replays byte for byte. */
function counterIds(prefix) {
  let n = 0;
  return () => {
    n += 1;
    return (prefix + String(n).padStart(21 - prefix.length, '0') + 'z').slice(0, 22);
  };
}

/** A simulated Mac: its own clock, its own device id, its own register map. */
function device(name, deviceId, short, startMs = BASE_MS) {
  let ms = startMs;
  const clock = createClock(short, () => ms);
  return {
    name,
    deviceId,
    clock,
    regs: new Map(),
    advance(d) { ms += d; return ms; },
    ctx(extra = {}) {
      return {
        mint: () => clock.tick(),
        me: ME,
        deviceId,
        personalSpaceId: null,
        newOpId: extra.newOpId ?? counterIds(name),
        newGid: extra.newGid ?? counterIds(`g${name}`),
        ...extra,
      };
    },
    /** Receive ops from a peer: absorb their stamps (the HLC receive rule) and fold. */
    receive(ops) {
      for (const op of ops) clock.observe(op.ts);
      foldAll(this.regs, ops);
      return this;
    },
    state(ctx = {}) {
      return materialize(this.regs, {
        me: ME,
        familySpaceId: null,
        currentMembers: new Set([ME, MAMA]),
        defaultSettings: defaultState().settings,
        ...ctx,
      });
    },
  };
}

const CATS = [
  { id: 'cat-1', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
  { id: 'cat-2', name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
];

/** A v1-shaped board. `note()`/`bar()` default `categoryId` to `cat-1` via the fixtures' CAT[0]. */
function board(patch = {}) {
  return {
    schemaVersion: 1,
    notes: [],
    bars: [],
    categories: clone(CATS),
    scratchpads: {},
    settings: { bundesland: 'HH', layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: false } },
    ...patch,
  };
}

/** The board a device starts from: migrate a v1 board at GENESIS stamps, as WP-1 says. */
function seed(dev, b) {
  const { ops } = migrateV1(clone(b), { memberId: ME, deviceId: dev.deviceId });
  foldAll(dev.regs, ops);
  return ops;
}

/** Every stamp in a register map. */
function stamps(regs) {
  const out = [];
  for (const cells of regs.values()) for (const reg of cells.values()) out.push(reg.stamp);
  return out;
}

/** A comparable snapshot of a whole register map — value, stamp and author per cell. */
function snapshot(regs) {
  const out = {};
  for (const key of [...regs.keys()].sort()) {
    const cells = regs.get(key);
    out[key] = {};
    for (const f of [...cells.keys()].sort()) {
      const r = cells.get(f);
      out[key][f] = [r.value, r.stamp, r.author];
    }
  }
  return out;
}

const idsOf = (list) => list.map((e) => e.id).sort();

// ─────────────────────────────────────────────────────────────────────────────
// ATT-40 — the primitive exists at all
// ─────────────────────────────────────────────────────────────────────────────

describe('ATT-40 — replaceAllOps exists and honours its contract signature', () => {
  test('the contract-declared export is a function and returns a plain array of ops', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')] }));
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board({ notes: [note('n2', '2026-04-01', 'neu')] }), A.ctx());
    assert.equal(typeof replaceAllOps, 'function');
    assert.ok(Array.isArray(ops), 'ops.contract.js §9 declares `@returns {Op[]}`');
    assert.ok(ops.length > 0, 'a replace that changes the board emits ops');
    for (const op of ops) assert.equal(typeof op.e, 'string');
  });

  test('every emitted op is admitted by the REAL validator — none of them is a board.reset', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')], scratchpads: { '2026-03': 'x' } }));
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board({ bars: [bar('b1', '2026-05-01', '2026-05-09', 'Urlaub')] }), A.ctx());
    for (const op of ops) {
      const c = classifyOp(op);
      assert.equal(c.status, 'admit', `${op.k} ${op.e}: ${c.reason || ''}`);
      assert.ok(['note.set', 'bar.set', 'cat.set', 'pad.set', 'pref.set'].includes(op.k),
        `${op.k} is not one of the five kinds a replace may emit`);
    }
  });

  test('the plan carries the diagnostics the store needs before the old board is gone', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')] }));
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ notes: [note('n2', '2026-04-01', 'neu')] }), A.ctx());
    assert.deepEqual(Object.keys(plan).sort(),
      ['gid', 'label', 'lossy', 'ops', 'removed', 'undoable', 'warnings', 'written'].sort());
    assert.equal(plan.lossy, false);
    assert.deepEqual(plan.warnings, []);
    assert.deepEqual(plan.written.filter((k) => k.startsWith('note:')), ['note:n2']);
    assert.deepEqual(plan.removed, ['note:n1']);
  });

  test('a bad ctx is a caller error and throws before anything is emitted', () => {
    const A = device('a', MAC_A, SHORT_A);
    assert.throws(() => planReplaceAll(A.regs, board(), { me: ME, deviceId: MAC_A }), ReplaceError);
    assert.throws(() => planReplaceAll(A.regs, board(), { ...A.ctx(), me: 'nope' }), ReplaceError);
    assert.throws(() => planReplaceAll(A.regs, board(), { ...A.ctx(), deviceId: 'nope' }), ReplaceError);
    assert.throws(() => planReplaceAll(A.regs, board(), { ...A.ctx(), personalSpaceId: FSP }), /psp_/);
    assert.throws(() => planReplaceAll(A.regs, 'not a board', A.ctx()), ReplaceError);
    assert.throws(() => planReplaceAll({ not: 'a map' }, board(), A.ctx()), /RegisterMap/);
  });

  test('neither the incoming board nor the register map is mutated', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')] }));
    const before = snapshot(A.regs);
    const incoming = board({ notes: [note('n2', '2026-04-01', 'neu')] });
    const incomingBefore = clone(incoming);
    A.advance(60_000);
    planReplaceAll(A.regs, incoming, A.ctx());
    assert.deepEqual(snapshot(A.regs), before, 'planning must not fold its own ops');
    assert.deepEqual(incoming, incomingBefore, 'the file is read, never edited');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.5 step 2 — fresh-stamped, full-field writes
// ─────────────────────────────────────────────────────────────────────────────

describe('§8.5 step 2 — full-field writes at FRESH stamps', () => {
  test('every stamp in the transaction is greater than every stamp already in the log', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')], scratchpads: { '2026-03': 'x' } }));
    const highWater = stamps(A.regs).sort().pop();
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board({ notes: [note('n1', '2026-03-02', 'neu')] }), A.ctx());
    for (const op of ops) {
      assert.equal(cmp(op.ts, highWater), 1, `${op.e} was stamped ${op.ts}, not above ${highWater}`);
    }
    // and they are strictly increasing, i.e. one `clock.tick()` per op (ADR 001 §2)
    const ts = ops.map((o) => o.ts);
    assert.deepEqual(ts, [...ts].sort(), 'stamps are not monotonic — mint() was not called per op');
    assert.equal(new Set(ts).size, ts.length, 'two ops share a stamp');
  });

  test('an incoming entity gets ALL its fields, not just the ones that differ', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board({ notes: [note('n1', '2026-03-01', 'Zahnarzt')] }), A.ctx());
    const op = ops.find((o) => o.e === 'note:n1');
    assert.ok(op, 'the imported note produced no op');
    const expected = [...CARRIED_FIELDS.note, ...Object.keys(IMPORT_DEFAULTS.note), '_born'].sort();
    assert.deepEqual(Object.keys(op.f).sort(), expected);
    assert.equal(op.f.visibility, 'privat', 'story 16.1: an imported entry is private, always');
    assert.equal(op.f._alive, true);
    assert.equal(op.f._born, op.ts, '`_born` is the op\'s own fresh stamp');
  });

  test('a field the import OMITS is CLEARED on an entity that already had one — replace, not merge', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt', { repeatsYearly: true })] }));
    assert.equal(getValue(A.regs, 'note:n1', 'repeatsYearly'), true);
    A.advance(60_000);
    // The same note, but the imported file has no `repeatsYearly` at all.
    const incoming = board({ notes: [{ id: 'n1', date: '2026-03-01', text: 'alt', categoryId: 'cat-1' }] });
    const plan = planReplaceAll(A.regs, incoming, A.ctx());
    foldAll(A.regs, plan.ops);
    assert.equal(getValue(A.regs, 'note:n1', 'repeatsYearly'), null,
      'v1 installs the payload entry wholesale, so an omitted field is GONE, not inherited');
    assert.equal('repeatsYearly' in A.state().notes.find((n) => n.id === 'n1'), false,
      'a cleared register is ABSENT in the projection — never a fabricated false');
  });

  test('a field the import omits on a BRAND NEW entity writes no null — the diff stays bounded', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const incoming = board({ notes: [{ id: 'fresh', date: '2026-03-01', text: 'neu', categoryId: 'cat-1' }] });
    const ops = replaceAllOps(A.regs, incoming, A.ctx());
    const op = ops.find((o) => o.e === 'note:fresh');
    assert.equal('repeatsYearly' in op.f, false,
      'there is nothing to clear on an entity that does not exist yet');
    assert.equal(op.f.text, 'neu');
  });

  test('the imported board is what the board shows afterwards', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({
      notes: [note('gone', '2026-01-01', 'weg'), note('kept', '2026-02-02', 'alt')],
      bars: [bar('oldbar', '2026-01-05', '2026-01-09', 'Alt')],
      scratchpads: { '2026-01': 'alte Notiz' },
    }));
    A.advance(60_000);
    const incoming = board({
      notes: [note('kept', '2026-02-03', 'neu'), note('added', '2026-06-01', 'dazu')],
      bars: [bar('newbar', '2026-07-01', '2026-07-14', 'Urlaub')],
      scratchpads: { '2026-07': 'Sommer' },
    });
    foldAll(A.regs, replaceAllOps(A.regs, incoming, A.ctx()));
    const s = A.state();
    assert.deepEqual(idsOf(s.notes), ['added', 'kept']);
    assert.deepEqual(idsOf(s.bars), ['newbar']);
    assert.deepEqual(s.scratchpads, { '2026-07': 'Sommer' });
    assert.equal(s.notes.find((n) => n.id === 'kept').text, 'neu');
    assert.deepEqual(idsOf(s.categories), ['cat-1', 'cat-2']);
  });

  test('array ORDER survives the import, because `_born` is re-minted in file order', () => {
    // ADR 001 §13.8: array order is user-visible through the "+n" capacity slice
    // (`layout.js:209`). A shuffled import must produce the shuffled order, not the old one.
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'a'), note('n2', '2026-03-01', 'b'), note('n3', '2026-03-01', 'c')] }));
    assert.deepEqual(A.state().notes.map((n) => n.id), ['n1', 'n2', 'n3']);
    A.advance(60_000);
    const shuffled = board({ notes: [note('n3', '2026-03-01', 'c'), note('n1', '2026-03-01', 'a'), note('n2', '2026-03-01', 'b')] });
    foldAll(A.regs, replaceAllOps(A.regs, shuffled, A.ctx()));
    assert.deepEqual(A.state().notes.map((n) => n.id), ['n3', 'n1', 'n2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. §8.5 step 3 — tombstones, and NO RESURRECTION
// ─────────────────────────────────────────────────────────────────────────────

describe('§8.5 step 3 — `{_alive:false}` for what the import does not have', () => {
  test('a live local entity absent from the import gets exactly `{_alive:false}`', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'weg')], scratchpads: { '2026-03': 'weg' } }));
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board(), A.ctx());
    const dead = ops.filter((o) => o.f._alive === false);
    assert.deepEqual(dead.map((o) => o.e).sort(), ['note:n1', 'pad:2026-03']);
    for (const op of dead) assert.deepEqual(Object.keys(op.f), ['_alive'], 'the tombstone is exactly ADR 001 §8.5 step 3');
  });

  test('an ALREADY dead entity gets no second tombstone — the transaction stays bounded', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'weg')] }));
    A.advance(1000);
    // delete it the ordinary way first
    const first = replaceAllOps(A.regs, board(), A.ctx());
    foldAll(A.regs, first);
    A.advance(60_000);
    const second = replaceAllOps(A.regs, board(), A.ctx());
    assert.deepEqual(second.filter((o) => o.e === 'note:n1'), [],
      'a corpse must not be re-stamped on every subsequent import');
  });

  test('an entity the import DOES have is never tombstoned', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'bleibt')] }));
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board({ notes: [note('n1', '2026-03-01', 'bleibt')] }), A.ctx());
    assert.equal(ops.filter((o) => o.f._alive === false).length, 0);
    assert.equal(ops.find((o) => o.e === 'note:n1').f._alive, true);
  });

  test('NO RESURRECTION: an entity the import does not have stays gone, however the ops are folded', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'weg'), note('n2', '2026-03-02', 'auch weg')] }));
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board({ notes: [note('n3', '2026-04-01', 'nur ich')] }), A.ctx());

    // folded once, folded twice, folded in reverse — a set, not a sequence (ADR 001 §0.2)
    const orders = [ops, [...ops].reverse(), [...ops, ...ops]];
    for (const order of orders) {
      const regs = cloneRegisters(A.regs);
      foldAll(regs, order);
      const s = materialize(regs, { me: ME, familySpaceId: null, defaultSettings: defaultState().settings });
      assert.deepEqual(idsOf(s.notes), ['n3'], `fold order ${order.length} resurrected something`);
      assert.equal(getValue(regs, 'note:n1', '_alive'), false);
    }
  });

  test('a dead entity the import LISTS comes back — deletion is not a one-way door for a restore', () => {
    // The mirror image of the test above, and the reason `_alive: true` is FORCED rather than
    // defaulted: restoring yesterday's snapshot has to bring back what I deleted today (11.5).
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'gelöscht')] }));
    A.advance(1000);
    foldAll(A.regs, replaceAllOps(A.regs, board(), A.ctx()));
    assert.deepEqual(A.state().notes, []);

    A.advance(60_000);
    const yesterday = board({ notes: [note('n1', '2026-03-01', 'gelöscht')] });
    foldAll(A.regs, replaceAllOps(A.regs, yesterday, A.ctx()));
    assert.deepEqual(idsOf(A.state().notes), ['n1']);
    assert.equal(getValue(A.regs, 'note:n1', '_alive'), true);
  });

  test('an entry marked `_alive:false` IN the import is still imported alive, with a warning', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const incoming = board({ notes: [{ id: 'n1', date: '2026-03-01', text: 'x', categoryId: 'cat-1', _alive: false }] });
    const plan = planReplaceAll(A.regs, incoming, A.ctx());
    assert.equal(plan.ops.find((o) => o.e === 'note:n1').f._alive, true);
    assert.equal(plan.warnings.some((w) => w.includes('imported ALIVE')), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. §8.5 step 5 — SCOPE. The 19.4/11.5 convergence hole.
// ─────────────────────────────────────────────────────────────────────────────

describe('§8.5 step 5 — personal + local only; a family entry is not mine to blank', () => {
  /** My board, plus Mama's shared note and bar replicated into my register map. Her ops are
   *  stamped BEFORE mine, so "the import wins on stamp" cannot be what saves them — only the
   *  scope gate can. */
  function withFamily(A) {
    const mamaClock = createClock('MAMAMAC000000000', () => BASE_MS - 100_000);
    const famCtx = {
      act: MAMA, dev: `dev_${pad22('MAMAMAC')}`, gid: pad22('gfam'),
      mint: () => mamaClock.tick(), newOpId: counterIds('fam'), familySpaceId: FSP,
    };
    const famOps = [
      pubSet(famCtx, 'fnote', MAMA, 'mn1', { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-05', 'pub.text': 'Mamas Termin' }, { born: true }),
      pubSet(famCtx, 'fbar', MAMA, 'mb1', { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.startDate': '2026-06-01', 'pub.endDate': '2026-06-10', 'pub.label': 'Mamas Reise' }, { born: true }),
    ];
    foldAll(A.regs, famOps);
    return famOps;
  }

  test('no emitted op addresses a family entity, in any space, with any field', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'meins')] }));
    withFamily(A);
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board(), A.ctx({ personalSpaceId: PSP }));
    assert.ok(ops.length > 0);
    for (const op of ops) {
      const p = parseEntityKey(op.e);
      assert.ok(REPLACEABLE_KINDS.includes(p.kind), `${op.e} is a ${p.kind}`);
      assert.equal(p.owner, null, `${op.e} carries an owner segment — that is somebody's entity`);
      assert.notEqual(op.space, FSP);
      assert.ok(op.space === PSP || op.space === LOCAL_SPACE, `op.space ${op.space} is out of scope`);
      for (const f of Object.keys(op.f)) assert.equal(f.startsWith('pub.'), false, `${op.e} writes ${f}`);
    }
  });

  test("Mama's registers are BYTE-IDENTICAL after an import that empties my board", () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'meins')] }));
    withFamily(A);
    const famBefore = {};
    for (const [k, v] of A.regs) if (parseEntityKey(k).owner === MAMA) famBefore[k] = snapshot(new Map([[k, v]]))[k];
    assert.equal(Object.keys(famBefore).length, 2, 'the fixture did not install any family registers');

    A.advance(60_000);
    foldAll(A.regs, replaceAllOps(A.regs, board(), A.ctx({ personalSpaceId: PSP })));

    const famAfter = {};
    for (const [k, v] of A.regs) if (parseEntityKey(k).owner === MAMA) famAfter[k] = snapshot(new Map([[k, v]]))[k];
    assert.deepEqual(famAfter, famBefore, 'the import moved a register that belongs to another member');
  });

  test("and Mama's entries are still ON THE BOARD after the import wipes mine", () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'meins')] }));
    withFamily(A);
    A.advance(60_000);
    foldAll(A.regs, replaceAllOps(A.regs, board(), A.ctx({ personalSpaceId: PSP })));
    const s = A.state({ familySpaceId: FSP });
    // A foreign entry's `id` is its whole entity key (`materialize.js:foreignCandidate`), because
    // a bare uuid is forgeable and would collide in `assignLanes`. `uuid` is the series id.
    assert.deepEqual(s.notes.map((n) => n.uuid), ['mn1'], 'my note is gone (correct) and Mamas is not (also correct)');
    assert.deepEqual(s.bars.map((b) => b.uuid), ['mb1']);
    assert.equal(s.notes[0].isForeign, true);
    assert.equal(s.notes[0].text, 'Mamas Termin');
  });

  test('a family entity smuggled into the imported FILE is still not written', () => {
    // The file is data, not instructions. An `fnote` in `notes[]` must not become a family op.
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const hostile = board({ notes: [{ id: `${MAMA}/mn1`, date: '2026-05-05', text: 'übernommen', categoryId: 'cat-1' }] });
    const plan = planReplaceAll(A.regs, hostile, A.ctx({ personalSpaceId: PSP }));
    for (const op of plan.ops) {
      assert.equal(parseEntityKey(op.e).owner, null);
      assert.equal(op.space === PSP || op.space === LOCAL_SPACE, true);
    }
    assert.equal(plan.warnings.some((w) => w.includes('no usable id')), true,
      'an id containing the family key separator must be refused, not made into a key');
  });

  test('REPLACEABLE_KINDS is the whole scope, and it excludes every family kind', () => {
    assert.deepEqual([...REPLACEABLE_KINDS].sort(), ['bar', 'cat', 'note', 'pad', 'pref']);
    for (const k of ['fnote', 'fbar', 'member', 'space']) {
      assert.equal(REPLACEABLE_KINDS.includes(k), false, `${k} must never be replaceable`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. TWO DEVICES — the property `board.reset` could not have
// ─────────────────────────────────────────────────────────────────────────────

describe('19.4 — a paired device converges TO the import, without rewinding the log', () => {
  /** Two Macs of the SAME member, seeded from the same migrated board. */
  function pair(b) {
    const A = device('a', MAC_A, SHORT_A);
    const B = device('b', MAC_B, SHORT_B);
    const ops = migrateV1(clone(b), { memberId: ME, deviceId: MAC_A }).ops;
    foldAll(A.regs, ops);
    foldAll(B.regs, ops);
    return { A, B, seedOps: ops };
  }

  test('B converges to the board A imported, and nothing was deleted from the log', () => {
    const { A, B, seedOps } = pair(board({
      notes: [note('n1', '2026-03-01', 'alt'), note('n2', '2026-03-02', 'weg')],
      scratchpads: { '2026-03': 'alt' },
    }));

    A.advance(60_000);
    const incoming = board({ notes: [note('n1', '2026-03-01', 'importiert'), note('n9', '2026-09-09', 'neu')] });
    const txn = replaceAllOps(A.regs, incoming, A.ctx());
    foldAll(A.regs, txn);

    // The transaction is shipped as ordinary ops. Nothing is removed from the log and nothing
    // is re-stamped: B still holds every genesis op it had.
    B.receive(txn);
    assert.deepEqual(snapshot(A.regs), snapshot(B.regs), 'the two Macs disagree after the import');
    assert.deepEqual(idsOf(B.state().notes), ['n1', 'n9']);
    assert.equal(B.state().notes.find((n) => n.id === 'n1').text, 'importiert');
    assert.deepEqual(B.state().scratchpads, {});

    // The log is intact: re-folding the ORIGINAL migration ops on top changes nothing, because
    // they lost on stamp rather than having been erased.
    const regs = cloneRegisters(B.regs);
    foldAll(regs, seedOps);
    assert.deepEqual(snapshot(regs), snapshot(B.regs), 'a re-delivered pre-import op changed the board');
  });

  test("B's edit made BEFORE the import loses to it, and B does not fight back", () => {
    const { A, B } = pair(board({ notes: [note('n1', '2026-03-01', 'alt')] }));

    // B edits at T. A has seen it (the realistic case: paired Macs, then an import).
    B.advance(10_000);
    const bCtx = { mint: () => B.clock.tick(), me: ME, deviceId: MAC_B, newOpId: counterIds('b'), newGid: counterIds('gb') };
    const bEdit = replaceAllOps(B.regs, board({ notes: [note('n1', '2026-03-01', 'von B')] }), bCtx);
    foldAll(B.regs, bEdit);
    A.receive(bEdit);
    assert.equal(A.state().notes[0].text, 'von B');

    // A now imports at T+1.
    A.advance(60_000);
    const txn = replaceAllOps(A.regs, board({ notes: [note('n1', '2026-03-01', 'importiert')] }), A.ctx());
    foldAll(A.regs, txn);
    B.receive(txn);

    assert.equal(A.state().notes[0].text, 'importiert');
    assert.equal(B.state().notes[0].text, 'importiert', 'B did not converge to the import');
    assert.deepEqual(snapshot(A.regs), snapshot(B.regs));

    // And B re-emitting its old ops (a retry from the outbox) does not undo the import.
    B.receive(bEdit);
    A.receive(bEdit);
    assert.equal(B.state().notes[0].text, 'importiert');
    assert.deepEqual(snapshot(A.regs), snapshot(B.regs));
  });

  test('the transaction is a SET: split it, reorder it, duplicate it — B lands in the same place', () => {
    const { A, B } = pair(board({
      notes: [note('n1', '2026-03-01', 'alt'), note('n2', '2026-03-02', 'weg')],
      bars: [bar('b1', '2026-04-01', '2026-04-05', 'Alt')],
      scratchpads: { '2026-03': 'alt' },
    }));
    A.advance(60_000);
    const txn = replaceAllOps(A.regs, board({
      notes: [note('n1', '2026-03-01', 'neu')],
      bars: [bar('b2', '2026-05-01', '2026-05-05', 'Neu')],
    }), A.ctx());
    foldAll(A.regs, txn);

    const deliveries = [
      [...txn].reverse(),
      [...txn.slice(3), ...txn.slice(0, 3)],
      [...txn, ...txn],
      [...txn.filter((_, i) => i % 2 === 0), ...txn.filter((_, i) => i % 2 === 1), ...txn],
    ];
    for (const order of deliveries) {
      const C = device('c', MAC_B, SHORT_B);
      foldAll(C.regs, migrateV1(clone(board({
        notes: [note('n1', '2026-03-01', 'alt'), note('n2', '2026-03-02', 'weg')],
        bars: [bar('b1', '2026-04-01', '2026-04-05', 'Alt')],
        scratchpads: { '2026-03': 'alt' },
      })), { memberId: ME, deviceId: MAC_A }).ops);
      C.receive(order);
      assert.deepEqual(snapshot(C.regs), snapshot(A.regs), `delivery order of ${order.length} ops diverged`);
    }
    assert.deepEqual(idsOf(B.state().notes), ['n1', 'n2'], 'B was never delivered to; it is the control');
  });

  test('two imports of the SAME file are idempotent on the projected board', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')] }));
    const incoming = board({ notes: [note('n2', '2026-04-04', 'neu')], scratchpads: { '2026-04': 'x' } });
    A.advance(60_000);
    foldAll(A.regs, replaceAllOps(A.regs, incoming, A.ctx()));
    const first = A.state();
    A.advance(60_000);
    foldAll(A.regs, replaceAllOps(A.regs, incoming, A.ctx()));
    const second = A.state();
    assert.deepEqual(stripV2Fields(second), stripV2Fields(first),
      're-importing the same file must not change the board');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Story 5.4 — import is one group, and it is not undoable
// ─────────────────────────────────────────────────────────────────────────────

describe('5.4 — import is excluded from undo', () => {
  test('the plan says so, in a constant the retrofit cannot decide otherwise by accident', () => {
    assert.equal(REPLACE_ALL_UNDOABLE, false);
    assert.equal(REPLACE_ALL_LABEL, 'replaceAll');
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'x')] }));
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board(), A.ctx());
    assert.equal(plan.undoable, false);
    assert.equal(plan.label, 'replaceAll');
  });

  test('every content op carries ONE gid — not one per entity', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({
      notes: [note('n1', '2026-03-01', 'a'), note('n2', '2026-03-02', 'b')],
      scratchpads: { '2026-03': 'x' },
    }));
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ bars: [bar('b1', '2026-05-01', '2026-05-02', 'B')] }), A.ctx());
    const content = plan.ops.filter((o) => o.k !== 'pref.set');
    assert.ok(content.length >= 5, `expected several content ops, got ${content.length}`);
    assert.deepEqual([...new Set(content.map((o) => o.gid))], [plan.gid]);
  });

  test('the settings op carries NO gid — rule U6, `pref.set` is never undone', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ settings: { rowHeight: 30 } }), A.ctx());
    const pref = plan.ops.find((o) => o.k === 'pref.set');
    assert.ok(pref, 'settings produced no pref.set');
    assert.equal(pref.gid, null);
    assert.equal(pref.space, LOCAL_SPACE);
  });

  test('v1 parity: the store clears both stacks — this module never emits an inverse op', () => {
    // The characterization for this is `store-persistence.test.js:791` ("clears both undo and
    // redo — import is not undoable"). What core has to guarantee is the other half: the
    // transaction contains no op that would let an undo stack rebuild the pre-import board.
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'alt')] }));
    A.advance(60_000);
    const ops = replaceAllOps(A.regs, board(), A.ctx());
    for (const op of ops) {
      assert.equal(op.act, ME);
      assert.equal(op.dev, MAC_A);
    }
    // v1 itself, for the record this test is characterizing.
    store.state = defaultState();
    store.undoStack.length = 0;
    store.redoStack.length = 0;
    store.undoStack.push({ label: 'x', snap: {} });
    store.redoStack.push({ label: 'y', snap: {} });
    store.replaceAll(defaultState());
    assert.equal(store.canUndo(), false);
    assert.equal(store.canRedo(), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings — the `local` half of §8.5 step 5
// ─────────────────────────────────────────────────────────────────────────────

describe('settings are replaced too, in the LOCAL space', () => {
  test('the imported settings land as pref registers and reach the board', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ settings: { bundesland: 'HH', rowHeight: 30, layers: { feiertage: true } } }));
    A.advance(60_000);
    const incoming = board({ settings: { bundesland: 'BY', layers: { schulferien: true } } });
    foldAll(A.regs, replaceAllOps(A.regs, incoming, A.ctx()));
    const s = A.state();
    assert.equal(s.settings.bundesland, 'BY');
    assert.equal(s.settings.layers.schulferien, true);
    assert.equal(s.settings.rowHeight, 22,
      'a pref the imported file does not carry reverts to the v1 default, exactly as replaceAll does');
  });

  test('the sync cursor and the per-member view toggles are NOT settings and survive', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    // device-local bookkeeping, written the way the sync layer will write it
    A.advance(1000);
    const cursorOp = planReplaceAll(
      A.regs,
      board({ settings: { [`lastSeenSeq.${FSP}`]: '42', [`hiddenMembers.${MAMA}`]: true } }),
      A.ctx(),
    ).ops.find((o) => o.k === 'pref.set');
    foldAll(A.regs, [cursorOp]);
    assert.equal(getValue(A.regs, 'pref:app', `lastSeenSeq.${FSP}`), '42');

    A.advance(60_000);
    foldAll(A.regs, replaceAllOps(A.regs, board({ settings: { bundesland: 'NW' } }), A.ctx()));
    assert.equal(getValue(A.regs, 'pref:app', `lastSeenSeq.${FSP}`), '42',
      'clearing the sync cursor would light a "neu" dot on every foreign entry (17.5)');
    assert.equal(getValue(A.regs, 'pref:app', `hiddenMembers.${MAMA}`), true,
      'clearing this would silently un-hide a member the user chose to hide (17.3)');
    assert.deepEqual([...PRESERVED_PREF_PREFIXES].sort(), ['hiddenMembers', 'lastSeenSeq']);
  });

  test('a board with no settings at all still clears the ones this device holds', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ settings: { bundesland: 'HH', rowHeight: 30 } }));
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ settings: undefined }), A.ctx());
    const pref = plan.ops.find((o) => o.k === 'pref.set');
    assert.ok(pref);
    assert.equal(pref.f.bundesland, null);
    assert.equal(pref.f.rowHeight, null);
    foldAll(A.regs, plan.ops);
    assert.equal(A.state().settings.rowHeight, 22);
  });

  test('a nested settings object is flattened to dotted register names', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ settings: { layers: { feiertage: false } } }), A.ctx());
    const pref = plan.ops.find((o) => o.k === 'pref.set');
    assert.equal(pref.f['layers.feiertage'], false);
    assert.equal(Object.keys(pref.f).every((k) => typeof pref.f[k] !== 'object' || pref.f[k] === null), true);
  });

  test('an array-valued setting is dropped with a warning rather than crashing the import', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ settings: { bundesland: 'HH', evil: [1, 2, 3] } }), A.ctx());
    assert.equal(plan.lossy, true);
    assert.equal(plan.warnings.some((w) => w.includes('evil')), true);
    assert.equal(plan.ops.find((o) => o.k === 'pref.set').f.bundesland, 'HH');
  });

  test('`__proto__` in the settings is dropped, not written', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const hostile = board();
    hostile.settings = JSON.parse('{"bundesland":"HH","__proto__":{"admin":true}}');
    const plan = planReplaceAll(A.regs, hostile, A.ctx());
    const pref = plan.ops.find((o) => o.k === 'pref.set');
    assert.equal(Object.prototype.hasOwnProperty.call(pref.f, '__proto__'), false);
    assert.equal(({}).admin, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Warnings — "nothing is ever lost" means the user is told before the file replaces the board
// ─────────────────────────────────────────────────────────────────────────────

describe('warnings and the `lossy` flag', () => {
  test('an unrepresentable value is dropped with a lossy warning', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({
      notes: [{ id: 'n1', date: '2026-03-01', text: 'x'.repeat(200), categoryId: 'cat-1' }],
    }), A.ctx());
    assert.equal(plan.lossy, true);
    assert.equal(plan.warnings.some((w) => w.includes('not representable')), true);
    assert.equal('text' in plan.ops.find((o) => o.e === 'note:n1').f, false);
  });

  test('an unrepresentable GOVERNING value falls back to the privacy-safe default', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({
      notes: [{ id: 'n1', date: '2026-03-01', text: 'x', categoryId: 'cat-1', visibility: 'öffentlich' }],
    }), A.ctx());
    assert.equal(plan.ops.find((o) => o.e === 'note:n1').f.visibility, 'privat',
      'a visibility this build does not understand must never widen exposure');
    assert.equal(plan.lossy, true);
  });

  test('a duplicate id takes the first and says so', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({
      notes: [note('n1', '2026-03-01', 'erste'), note('n1', '2026-03-02', 'zweite')],
    }), A.ctx());
    assert.equal(plan.ops.filter((o) => o.e === 'note:n1').length, 1);
    assert.equal(plan.ops.find((o) => o.e === 'note:n1').f.text, 'erste');
    assert.equal(plan.warnings.some((w) => w.includes('more than once')), true);
    assert.equal(plan.lossy, true);
  });

  test('a `notes` key that is not an array is a LOSSY warning, never a silent empty board', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'x')] }));
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ notes: 'nope' }), A.ctx());
    assert.equal(plan.lossy, true);
    assert.equal(plan.warnings.some((w) => w.includes('notes is not an array')), true);
  });

  test('an unknown top-level key is reported rather than dropped in silence', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({ opLog: [{ op: 'add' }], cursor: 7 }), A.ctx());
    assert.equal(plan.warnings.filter((w) => w.includes('unknown top-level key')).length, 2);
    assert.equal(plan.lossy, true);
  });

  test('the DERIVED decorations of a v2 export round-trip without being called data loss', () => {
    // `store.exportJSON()` writes the MATERIALIZED state, which carries `entityKey`, `createdAt`,
    // `updatedBy`, `isNew`, … Every one of them is re-derived on the next projection. Reporting
    // them as loss would make `lossy` true for the app's own export file.
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'x')] }));
    const exported = A.state();
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, {
      schemaVersion: 2,
      notes: clone(exported.notes),
      bars: [],
      categories: clone(exported.categories),
      scratchpads: {},
      settings: clone(exported.settings),
    }, A.ctx());
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.lossy, false);
    foldAll(A.regs, plan.ops);
    assert.deepEqual(idsOf(A.state().notes), ['n1']);
    assert.equal(A.state().notes[0].text, 'x');
  });

  test('a v2 export keeps the visibility it was exported with', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'x')] }));
    A.advance(60_000);
    const plan = planReplaceAll(A.regs, board({
      notes: [note('n1', '2026-03-01', 'x', { visibility: 'geteilt', coEdit: true })],
    }), A.ctx());
    const op = plan.ops.find((o) => o.e === 'note:n1');
    assert.equal(op.f.visibility, 'geteilt');
    assert.equal(op.f.coEdit, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invariants that keep this module honest as it is edited
// ─────────────────────────────────────────────────────────────────────────────

describe('module invariants', () => {
  test('every field of every replaceable kind is covered — a new field cannot slip through', () => {
    for (const kind of ['note', 'bar', 'cat', 'pad']) {
      const declared = fieldsOf(kind).slice().sort();
      const covered = [...CARRIED_FIELDS[kind], ...Object.keys(IMPORT_DEFAULTS[kind]), '_born'].sort();
      assert.deepEqual(covered, declared,
        `FIELDS.${kind} and replace.js disagree; the module-level guard should already have thrown`);
    }
  });

  test('an entity with no live register at all is not swept — nothing to tombstone', () => {
    const A = device('a', MAC_A, SHORT_A);
    A.advance(60_000);
    const plan = planReplaceAll(new Map(), board(), A.ctx());
    assert.deepEqual(plan.removed, []);
    assert.deepEqual(plan.ops.filter((o) => o.f._alive === false), []);
  });

  test('a null RegisterMap is a first import, not a crash', () => {
    const A = device('a', MAC_A, SHORT_A);
    A.advance(60_000);
    const ops = replaceAllOps(null, board({ notes: [note('n1', '2026-03-01', 'x')] }), A.ctx());
    assert.equal(ops.some((o) => o.e === 'note:n1'), true);
  });

  test('the solo placeholder space is used when there is no personal space yet', () => {
    const A = device('a', MAC_A, SHORT_A);
    A.advance(60_000);
    const ops = replaceAllOps(new Map(), board({ notes: [note('n1', '2026-03-01', 'x')] }), A.ctx());
    for (const op of ops) {
      assert.equal(op.space === PERSONAL_PLACEHOLDER || op.space === LOCAL_SPACE, true, `space ${op.space}`);
    }
  });

  test('categories are emitted FIRST, so the dangling-reference fallback is the file\'s first one', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board());
    A.advance(60_000);
    const incoming = board({
      categories: [{ id: 'cx', name: 'Erste', paletteRef: 'blau', visible: true }],
      notes: [note('n1', '2026-03-01', 'x', { categoryId: 'weg' })],
    });
    const ops = replaceAllOps(A.regs, incoming, A.ctx());
    // Step 2's WRITES only — step 3's tombstone sweep runs after all of them and is ordered by
    // entity key, so `cat:cat-1`'s tombstone legitimately follows `note:n1`'s write.
    const writes = ops.filter((o) => o.f._alive !== false);
    const firstNote = writes.findIndex((o) => o.e.startsWith('note:'));
    const lastCat = writes.map((o) => o.e.startsWith('cat:')).lastIndexOf(true);
    assert.ok(lastCat >= 0 && firstNote >= 0, 'the fixture emitted neither a category nor a note write');
    assert.ok(lastCat < firstNote, 'a category write is emitted after a note write');
    foldAll(A.regs, ops);
    assert.equal(A.state().notes[0].categoryId, 'cx',
      'the dangling reference is repaired by the PROJECTION, not written into the log');
    assert.equal(getValue(A.regs, 'note:n1', 'categoryId'), 'weg',
      'and the log still says what the file said — the repair is idempotent, not a mutation');
  });

  test('the tombstone sweep is deterministic: the same boards produce the same op order', () => {
    const b = board({ notes: [note('n1', '2026-03-01', 'a'), note('n2', '2026-03-02', 'b')], scratchpads: { '2026-05': 'x', '2026-01': 'y' } });
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const A = device('a', MAC_A, SHORT_A);
      seed(A, b);
      A.advance(60_000);
      keys.push(j(replaceAllOps(A.regs, board(), A.ctx()).map((o) => o.e)));
    }
    assert.equal(new Set(keys).size, 1, `op order is not deterministic: ${keys.join(' | ')}`);
    assert.match(keys[0], /note:n1/);
  });

  test('hasRegister still tells a never-written register apart from a cleared one after an import', () => {
    const A = device('a', MAC_A, SHORT_A);
    seed(A, board({ notes: [note('n1', '2026-03-01', 'x', { repeatsYearly: true })] }));
    A.advance(60_000);
    foldAll(A.regs, replaceAllOps(A.regs, board({ notes: [{ id: 'n1', date: '2026-03-01', text: 'x' }] }), A.ctx()));
    assert.equal(hasRegister(A.regs, 'note:n1', 'repeatsYearly'), true, 'the register EXISTS');
    assert.equal(getValue(A.regs, 'note:n1', 'repeatsYearly'), null, 'and it holds null — cleared, not absent');
  });
});
