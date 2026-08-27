// tests/tier1/core-materialize.test.js — src/js/core/materialize.js (ADR 001 §5, ADR 004 §4/§5/§6).
//
// WHAT THIS SUITE IS FOR. `materialize()` is the compatibility contract: RegisterMap + ctx → the
// EXACT v1 state shape that `layout.js` and `board.js` already consume. If it is wrong, every
// pixel downstream is wrong, and the failure mode is silent — a board that renders, plausibly,
// with the wrong entries hidden behind "+n".
//
// So the judge here is v1 itself, twice over:
//
//   1. A REAL v1 board built by `tests/helpers/fixtures.js` (which is built on the app's own
//      `defaultState()`) is compiled to ops the way ADR 001 §8.2 says migration will, folded, and
//      materialized. `stripV2Fields(...)` must deep-equal the v1 board. That is ADR 001 §8.3's
//      acceptance criterion (property P8) in miniature, and it is the only check that would catch
//      a field quietly renamed or defaulted.
//   2. The REAL `layout.js` is run over both boards and the two render models are compared —
//      column by column, day by day, including the capacity slice and the lane assignment. Array
//      ORDER is user-visible (stories 2.4, 2.5, 3.8) and a deep-equal on the arrays alone would
//      not prove it survived; running the actual layout does.
//
// Everything else is adversarial. This module is one half of a sync system, so the ops are
// reordered, duplicated, split into partitions, delivered late, and delivered by a hostile member
// who reuses one of my uuids — because "converges under a friendly delivery order" is not a
// property, it is a coincidence.
//
// TWO NOTES ON MECHANISM.
//
// * The fold is the REAL one — `registers.js`'s `fold` / `foldAll` / `mergeMaps`, not a local
//   stand-in. Materialization is only a pure function of the register map if the map it is
//   handed is the map the product actually builds, and `applyOp`'s structural guard (a real
//   stamp, a real OpId, a real MemberId, a declared field name) is part of what makes the input
//   well-formed. The fold's own ACI-ness is `registers.js`'s test; what is tested here is that
//   `materialize` adds no order-dependence of its own on top of it.
// * The clock is injected everywhere; no test reads wall time. Stamps are written by `fmt()` from
//   the real `stamp.js`, so a change to the stamp format breaks these tests loudly.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { boardState, CAT, note as v1note, bar as v1bar } from '../helpers/fixtures.js';
import { defaultState } from '../../src/js/store.js';
import { buildBoard, visibleStart } from '../../src/js/layout.js';

import {
  materialize, createdAt, updatedAt, updatedBy,
  DEFAULT_SETTINGS, SCHEMA_VERSION_V2, PREF_ENTITY, PROMOTABLE,
  V1_ENTRY_FIELDS, V2_ENTRY_FIELDS, stripV2Fields, toV1Board, exportV1JSON,
  MaterializeError,
} from '../../src/js/core/materialize.js';
import { fmt } from '../../src/js/core/stamp.js';
import { FIELDS, flattenPref } from '../../src/js/core/ops.js';
import {
  familyKey, pinnedMonthsRenderable, yearIsRenderable, dow, monthOrdinal, addMonths,
} from '../../src/js/core/entities.js';
import * as v1dates from '../../src/js/dates.js';
import { fold, foldAll, mergeMaps, applyOp, emptyRegisters } from '../../src/js/core/registers.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const DEV_A = 'A0000000000000AA';
const DEV_B = 'B0000000000000BB';
const ZERO_DEV = '0'.repeat(16);

const ME = 'mem_MeMeMeMeMeMeMeMeMeMeMe'.slice(0, 26);
const MAMA = 'mem_MaMaMaMaMaMaMaMaMaMaMa'.slice(0, 26);
const ADMIN = 'mem_AdAdAdAdAdAdAdAdAdAdAd'.slice(0, 26);

/** ADR 001 §8.1 — the migration stamp: a constant carrying ONLY the v1 array index. */
const GENESIS = (i) => fmt(0, i, ZERO_DEV);

/** A tiny seeded PRNG so every shuffle in this file is replayable from its seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Monotonic stamp minter for a named device. No wall clock anywhere in this file. */
function minter(dev, startMs = 1_700_000_000_000) {
  let ms = startMs;
  let ctr = 0;
  return {
    tick() { ctr += 1; return fmt(ms, ctr, dev); },
    at(msAbs, c = 0) { return fmt(msAbs, c, dev); },
    jump(n) { ms += n; ctr = 0; },
  };
}

let opSeq = 0;
/** An op envelope. `id` is a real 22-char b64url OpId because `applyOp` insists on one. */
function op(ts, act, e, f) {
  opSeq += 1;
  return {
    v: 1, id: String(opSeq).padStart(22, 'A'), ts, act,
    dev: 'dev_AAAAAAAAAAAAAAAAAAAAAA', gid: 'g', k: 'x', e, f,
  };
}

/**
 * ADR 001 §6's join — the REAL one from `registers.js`. `foldOps(ops)` folds a fresh map;
 * `foldOps(ops, regs)` folds into an existing one, which is how the late-delivery and partition
 * tests below deliver a second batch.
 */
const foldOps = (ops, into) => (into ? foldAll(into, ops) : fold(ops));

/** A RegisterMap holding only `{value, stamp, author}` — the contract's Register, no extras. */
function bareRegisters(regs) {
  const out = new Map();
  for (const [e, cell] of regs) {
    const c = new Map();
    for (const [f, r] of cell) c.set(f, { value: r.value, stamp: r.stamp, author: r.author });
    out.set(e, c);
  }
  return out;
}

const J = (v) => JSON.stringify(v);

// Captured ONCE. `defaultState()` mints a fresh uuid for `lastCategoryId` on every call, so a
// per-call ctx would make two materializations of the same registers differ — which would make
// every byte-comparison below fail for a reason that has nothing to do with materialize.
const V1_DEFAULT_SETTINGS = Object.freeze(defaultState().settings);

/** ctx for a solo board: no member, no family space. */
const soloCtx = (extra = {}) => ({ defaultSettings: V1_DEFAULT_SETTINGS, ...extra });

/** ctx for a family board where I am ME and Mama and the admin are current members. */
const familyCtx = (extra = {}) => ({
  me: ME,
  familySpaceId: 'fsp_0000000000000000000000',
  members: new Map([
    [ME, { displayName: 'Papa', colorRef: 'blau', initial: 'P' }],
    [MAMA, { displayName: 'Mama', colorRef: 'magenta', initial: 'M' }],
    [ADMIN, { displayName: 'Oma', colorRef: 'gruen', initial: 'O' }],
  ]),
  currentMembers: new Set([ME, MAMA, ADMIN]),
  defaultSettings: V1_DEFAULT_SETTINGS,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// The v1 → ops compiler used by the compatibility tests.
//
// This is ADR 001 §8.2's emission list, written out by hand rather than imported: `migrate1to2.js`
// is a later work package (its own module, its own tests), and a compatibility test that derived
// its input from the very code it is meant to check would prove nothing. One global counter runs
// categories → notes → bars → scratchpads, exactly as §8.1 specifies, so the stamp carries the v1
// array index and v1's insertion order survives the deterministic sort (risk R12).
// ─────────────────────────────────────────────────────────────────────────────

function v1ToOps(board, { act = ME, constantGenesis = false } = {}) {
  const ops = [];
  let i = 0;
  const g = () => (constantGenesis ? GENESIS(0) : GENESIS(i++));

  for (const c of board.categories) {
    ops.push(op(g(), act, `cat:${c.id}`, {
      name: c.name, nameEn: c.nameEn, paletteRef: c.paletteRef,
      visible: c.visible !== false, defaultVisibility: 'privat',
      _alive: true, _born: GENESIS(0),
    }));
  }
  for (const n of board.notes) {
    ops.push(op(g(), act, `note:${n.id}`, {
      date: n.date, text: n.text, categoryId: n.categoryId,
      repeatsYearly: !!n.repeatsYearly,
      visibility: 'privat', coEdit: false, _alive: true, _born: GENESIS(0),
    }));
  }
  for (const b of board.bars) {
    ops.push(op(g(), act, `bar:${b.id}`, {
      startDate: b.startDate, endDate: b.endDate, label: b.label,
      categoryId: b.categoryId,
      visibility: 'privat', coEdit: false, _alive: true, _born: GENESIS(0),
    }));
  }
  for (const key of Object.keys(board.scratchpads).sort()) {
    ops.push(op(g(), act, `pad:${key}`, {
      text: board.scratchpads[key], _alive: true, _born: GENESIS(0),
    }));
  }
  ops.push(op(g(), act, PREF_ENTITY, flattenPref(board.settings)));

  // `_born` must carry the entity's OWN index, not a shared one — that is the whole point of
  // §8.1. Rewrite it now that every op has its index, so the emission above stays readable.
  ops.forEach((o) => { if ('_born' in o.f) o.f._born = o.ts; });
  return ops;
}

/** The full pipeline the compatibility tests exercise. */
const fromV1 = (board, ctx = soloCtx(), opts = {}) =>
  materialize(foldOps(v1ToOps(board, opts)), ctx);

/**
 * A board with real content in every one of the four content buckets — THE §8.3 GATE FIXTURE.
 *
 * THE BARS ARE DELIBERATELY NOT IN DATE ORDER, and that is load-bearing (ATT-50). The original
 * fixture listed them `b-1 … b-4`, which happened to be exactly `(startDate asc, endDate desc,
 * id asc)` — so the round-trip gate below passed while `cmpBars` was re-sorting bars and
 * destroying the v1 array order §8.3 promises to preserve. A gate that cannot fail is not a gate.
 *
 * The file order here (`b-3, b-1, b-4, b-2`) differs from the date order (`b-1, b-2, b-3, b-4`)
 * in three of four positions, and the notes are likewise NOT in date order, so any comparator
 * that ignores `_born` reorders this fixture visibly.
 */
function richBoard() {
  return boardState({
    notes: [
      v1note('n-1', '2026-03-04', 'Zahnarzt'),
      v1note('n-2', '2026-03-04', 'Elternabend', { categoryId: CAT[1] }),
      v1note('n-3', '2026-03-04', 'Yoga', { categoryId: CAT[2] }),
      v1note('n-4', '2026-03-04', 'Steuer', { categoryId: CAT[3] }),
      v1note('n-5', '2024-07-19', 'Omas Geburtstag', { repeatsYearly: true }),
      v1note('n-6', '2026-11-30', 'Advent', { categoryId: CAT[1] }),
    ],
    bars: [
      v1bar('b-3', '2026-02-15', '2026-02-28', 'Urlaub', { categoryId: CAT[2] }),
      v1bar('b-1', '2026-02-10', '2026-04-20', 'Projekt Nord'),
      v1bar('b-4', '2026-02-16', '2026-02-20', 'Messe', { categoryId: CAT[3] }),
      v1bar('b-2', '2026-02-10', '2026-03-01', 'Sprint', { categoryId: CAT[1] }),
    ],
    scratchpads: { '2026-03': 'Milch\nBrot', '2026-01': 'Vorsätze', '2026-12': 'Geschenke' },
  });
}

/** The date comparator `cmpBars` used to be — kept ONLY so the gate can prove it is not in use. */
const dateOrderIds = (bars) => [...bars].sort((a, b) =>
  (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0) ||
  (b.endDate < a.endDate ? -1 : b.endDate > a.endDate ? 1 : 0) ||
  (a.id < b.id ? -1 : 1)).map((b) => b.id);

// ═════════════════════════════════════════════════════════════════════════════
// A. THE COMPATIBILITY CONTRACT — v1 is the judge
// ═════════════════════════════════════════════════════════════════════════════

test('DEFAULT_SETTINGS reproduces v1 defaultState().settings, minus the two clock/uuid members', () => {
  // core/ may not import store.js (ADR 005 §2), so v1's defaults are duplicated in materialize.js.
  // Duplication rots. This test is the pin.
  const v1 = defaultState().settings;
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), Object.keys(v1).sort());
  assert.deepEqual(DEFAULT_SETTINGS.layers, v1.layers);
  for (const k of Object.keys(v1)) {
    if (k === 'startMonth' || k === 'lastCategoryId' || k === 'layers') continue;
    assert.equal(DEFAULT_SETTINGS[k], v1[k], `default settings drifted on "${k}"`);
  }
  // The two dynamic members are explicitly null, never a fabricated value.
  assert.equal(DEFAULT_SETTINGS.startMonth, null);
  assert.equal(DEFAULT_SETTINGS.lastCategoryId, null);
  assert.match(v1.startMonth, /^\d{4}-\d{2}$/);
});

test('a real v1 board round-trips to a deep-equal v1 board (ADR 001 §8.3, P8 in miniature)', () => {
  const board = richBoard();
  const out = fromV1(board);
  assert.deepEqual(stripV2Fields(out), board);
  // THE GATE MUST BE CAPABLE OF FAILING (ATT-50). Assert that the fixture's bars are genuinely
  // out of date order, so the deep-equal above is testing `_born` order and not agreeing with a
  // date sort by accident — which is exactly how the old fixture hid the defect.
  assert.notDeepEqual(dateOrderIds(board.bars), board.bars.map((b) => b.id),
    'the gate fixture bars are already in date order — this gate cannot fail');
  assert.deepEqual(out.bars.map((b) => b.id), board.bars.map((b) => b.id), 'v1 file order');
});

test('an empty v1 board round-trips too — the first-run case', () => {
  const board = boardState();
  assert.deepEqual(stripV2Fields(fromV1(board)), board);
});

test('the materialized board renders identically through the REAL layout.js', () => {
  // Array order is user-visible: the capacity slice at layout.js:209 and the per-column lane
  // rescue at :162-177 both depend on it. Deep-equal arrays would not prove order survived a
  // sort; running the actual layout does.
  const board = richBoard();
  const v2 = fromV1(board);
  const digest = (state) => buildBoard(state, { today: '2026-03-04' }).cols.map((c) => ({
    key: c.key,
    pad: c.pad,
    segs: c.segs.map((s) => [s.bar.id, s.lane, s.topRow, s.rows, s.labelRow]),
    days: c.days.filter((d) => !d.empty).map((d) => [
      d.date, d.notes.map((o) => o.note.id), d.allNotes.length, d.overflow, d.laneOverflow,
    ]),
  }));
  assert.deepEqual(digest(v2), digest(board));
});

test('v1 insertion order survives — and the GENESIS index is what carries it (R12)', () => {
  // Ids are chosen so that lexicographic uuid order is the REVERSE of insertion order. With
  // GENESIS(i) the arrays keep v1's order; with a constant genesis every comparison falls through
  // to id order and the board visibly changes. That difference is the whole justification for
  // putting the index inside the stamp.
  const board = boardState({
    notes: [
      v1note('zz', '2026-03-04', 'first'),
      v1note('mm', '2026-03-04', 'second'),
      v1note('aa', '2026-03-04', 'third'),
    ],
  });
  assert.deepEqual(fromV1(board).notes.map((n) => n.id), ['zz', 'mm', 'aa']);
  assert.deepEqual(
    fromV1(board, soloCtx(), { constantGenesis: true }).notes.map((n) => n.id),
    ['aa', 'mm', 'zz'],
  );
});

test('two independent migrations of the same board are byte-identical (R12)', () => {
  const board = richBoard();
  // Different devices, different arrival orders, same file.
  const a = materialize(foldOps(v1ToOps(board)), soloCtx());
  const b = materialize(foldOps(shuffled(v1ToOps(board), mulberry32(7))), soloCtx());
  assert.equal(J(a), J(b));
});

test('materialize stamps schemaVersion 2 and keeps the five v1 top-level keys', () => {
  const out = fromV1(richBoard());
  assert.equal(out.schemaVersion, SCHEMA_VERSION_V2);
  assert.deepEqual(Object.keys(out),
    ['schemaVersion', 'notes', 'bars', 'categories', 'scratchpads', 'settings']);
});

test('v2 fields are ADDITIVE — every v1 field is still present and unrenamed', () => {
  const out = fromV1(richBoard());
  for (const n of out.notes) {
    for (const k of ['id', 'date', 'text', 'categoryId', 'repeatsYearly']) {
      assert.ok(k in n, `note lost v1 field ${k}`);
    }
  }
  for (const b of out.bars) {
    for (const k of ['id', 'startDate', 'endDate', 'label', 'categoryId']) {
      assert.ok(k in b, `bar lost v1 field ${k}`);
    }
  }
  for (const c of out.categories) {
    for (const k of ['id', 'name', 'nameEn', 'paletteRef', 'visible']) {
      assert.ok(k in c, `category lost v1 field ${k}`);
    }
  }
});

test('V2_ENTRY_FIELDS covers every non-v1 key materialize actually emits', () => {
  // If a decoration is added and this list is not updated, stripV2Fields stops producing a v1
  // shape and the migration AC (ADR 001 §8.3) silently starts comparing apples to pears.
  const v1NoteKeys = new Set(['id', 'date', 'text', 'categoryId', 'repeatsYearly']);
  const v1BarKeys = new Set(['id', 'startDate', 'endDate', 'label', 'categoryId']);
  const v1CatKeys = new Set(['id', 'name', 'nameEn', 'paletteRef', 'visible', 'defaultVisibility']);
  const out = materialize(
    foldOps(v1ToOps(richBoard())),
    familyCtx({ lastAckedPubLevel: () => 'privat' }),
  );
  const check = (arr, v1keys) => {
    for (const e of arr) {
      for (const k of Object.keys(e)) {
        assert.ok(v1keys.has(k) || V2_ENTRY_FIELDS.includes(k),
          `"${k}" is neither a v1 field nor listed in V2_ENTRY_FIELDS`);
      }
    }
  };
  check(out.notes, v1NoteKeys);
  check(out.bars, v1BarKeys);
  check(out.categories, v1CatKeys);
});

test('ATT-51 — `id` is the FIRST key of every entry, exactly as in v1 (11.4)', () => {
  // v1 writes `id` first (`store.js:19-24`, every `interact.js` create), so `board.json` reads
  // `{"id": …, "date": …}`. Assigning `id` in the decoration pass put it LAST — a key added to a
  // JS object after the fact keeps its insertion position — so every entry in the file changed
  // shape on upgrade day and a byte-wise diff of two exports was useless. 11.4 promises the file
  // stays human-readable; a diff nobody can read is not that.
  //
  // Against the old code the three assertions below read
  // ['date','text','categoryId','repeatsYearly','id'] and fail.
  const board = richBoard();
  const v1 = stripV2Fields(fromV1(board));
  assert.deepEqual(Object.keys(v1.notes[0]), ['id', 'date', 'text', 'categoryId', 'repeatsYearly']);
  assert.deepEqual(Object.keys(v1.bars[0]), ['id', 'startDate', 'endDate', 'label', 'categoryId']);
  assert.deepEqual(Object.keys(v1.categories[0]), ['id', 'name', 'nameEn', 'paletteRef', 'visible']);
  // and the same on the UNSTRIPPED entry — the v2 decoration is appended, never interleaved
  const out = fromV1(board);
  assert.equal(Object.keys(out.notes[0])[0], 'id');
  assert.equal(Object.keys(out.bars[0])[0], 'id');
  assert.equal(Object.keys(out.categories[0])[0], 'id');
  // v1's own file, byte for byte, through v1's own serializer
  assert.equal(JSON.stringify(v1.notes[0]), JSON.stringify(board.notes[0]));
  assert.equal(JSON.stringify(v1.bars[0]), JSON.stringify(board.bars[0]));
  // a FOREIGN entry keeps the rule too — its `id` is the entity key, and it is still first
  const fam = materialize(foldOps([
    op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'x1'),
      { _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.date': '2026-05-01', 'pub.text': 'Chor' }),
  ]), familyCtx());
  assert.equal(Object.keys(fam.notes[0])[0], 'id');
});

test('ATT-80/81 — stripV2Fields is TOTAL: no v2-only field can survive it', () => {
  // The privacy claim. v1's `exportJSON()` is `JSON.stringify(this.state, null, 2)` and 11.2
  // mails that file to somebody. Over a materialized state it carried `ownerId` (a MemberId),
  // `_born` (whose last 16 chars are this device's `deviceShort`), `entityKey` and `updatedBy`.
  //
  // The check ENUMERATES `FIELDS` rather than a hand-written list, so a register added to `note`,
  // `bar`, `cat`, `fnote` or `fbar` next year is covered the day it is added — which is the only
  // way a strip stays total without somebody remembering to update it.
  const v1Union = new Set(Object.values(V1_ENTRY_FIELDS).flat());
  const declared = [
    ...['note', 'bar', 'cat'].flatMap((k) => Object.keys(FIELDS[k])),
    ...['fnote', 'fbar'].flatMap((k) => Object.keys(FIELDS[k]).map((f) => (f.startsWith('pub.') ? f.slice(4) : f))),
  ];
  const v2Only = [...new Set(declared)].filter((f) => !v1Union.has(f));
  assert.ok(v2Only.length >= 5, 'the FIELDS enumeration produced nothing — the test is vacuous');

  const state = materialize(foldOps(v1ToOps(richBoard())), familyCtx({ lastAckedPubLevel: () => 'privat' }));
  // Plant every v2-only register name AND every decoration on a live entry, then strip.
  const planted = {
    ...state,
    notes: state.notes.map((n) => ({ ...n, ...Object.fromEntries(v2Only.map((f) => [f, 'LEAK'])) })),
    bars: state.bars.map((b) => ({ ...b, ...Object.fromEntries(v2Only.map((f) => [f, 'LEAK'])) })),
    categories: state.categories.map((c) => ({ ...c, ...Object.fromEntries(v2Only.map((f) => [f, 'LEAK'])) })),
  };
  const out = stripV2Fields(planted);
  for (const kind of ['notes', 'bars', 'categories']) {
    for (const e of out[kind]) {
      for (const f of [...v2Only, ...V2_ENTRY_FIELDS]) {
        assert.equal(f in e, false, `${kind}: "${f}" survived stripV2Fields`);
      }
    }
  }
  // …and the serialized bytes contain none of the four identifiers by value, either.
  const json = exportV1JSON(planted);
  for (const secret of [ME, MAMA, 'LEAK', ZERO_DEV]) {
    assert.equal(json.includes(secret), false, `${secret} reached the exported file`);
  }
  assert.equal(/\d{13}\.\d{6}\./.test(json), false, 'a stamp reached the exported file');

  // V2_ENTRY_FIELDS is the exact complement, so `undo.js:shadowContent` (which subtracts it)
  // and the strip (which keeps the whitelist) can never disagree about what "a v1 field" is.
  for (const f of v2Only) assert.ok(V2_ENTRY_FIELDS.includes(f), `V2_ENTRY_FIELDS is missing "${f}"`);
  for (const f of V2_ENTRY_FIELDS) assert.equal(v1Union.has(f), false, `"${f}" is a v1 field`);
});

test('ATT-80 — exportV1JSON round-trips back through migrateV1: schemaVersion 1, re-importable', () => {
  // `exportJSON()` writing `schemaVersion: 2` produced a file the product's own whole-board
  // primitive REFUSES ("already at schemaVersion 2"). The seam is what WP-3 calls instead.
  const state = materialize(foldOps(v1ToOps(richBoard())), familyCtx({ lastAckedPubLevel: () => 'privat' }));
  const file = JSON.parse(exportV1JSON(state));
  assert.equal(file.schemaVersion, 1);
  assert.deepEqual(Object.keys(file), ['schemaVersion', 'notes', 'bars', 'categories', 'scratchpads', 'settings']);
  assert.equal(exportV1JSON(state), JSON.stringify(toV1Board(state), null, 2), 'v1 exportJSON, verbatim');
  assert.equal(toV1Board, stripV2Fields, 'the seam is an alias, not a second implementation');
  // it survives a second lap through the whole pipeline unchanged
  assert.deepEqual(stripV2Fields(fromV1(file)), file);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. STEP 1–3 — projection, null, tombstones, renderability
// ═════════════════════════════════════════════════════════════════════════════

test('a null register is skipped — cleared is not a value (ADR 001 §5 step 1)', () => {
  const m = minter(DEV_A);
  const regs = foldOps([
    op(m.tick(), ME, 'note:n1', { _born: GENESIS(0), date: '2026-05-01', text: 'x', categoryId: CAT[0], _alive: true }),
    op(m.tick(), ME, 'note:n1', { categoryId: null }),
  ]);
  const cats = foldOps([op(GENESIS(0), ME, `cat:${CAT[0]}`, { name: 'A', _born: GENESIS(0), _alive: true })], regs);
  const out = materialize(cats, soloCtx());
  // The register is gone, so step 7 repairs the dangling reference rather than leaving `null`.
  assert.equal(out.notes[0].categoryId, CAT[0]);
  const noCat = materialize(foldOps([
    op(m.tick(), ME, 'note:n2', { _born: GENESIS(1), date: '2026-05-01', text: 'y', categoryId: 'gone', _alive: true }),
    op(m.tick(), ME, 'note:n2', { categoryId: null }),
  ]), soloCtx());
  assert.equal('categoryId' in noCat.notes[0], false);
});

test('a tombstoned entity does not appear, in any of the four buckets', () => {
  const m = minter(DEV_A);
  const regs = foldOps([
    op(GENESIS(0), ME, `cat:${CAT[0]}`, { name: 'A', visible: true, _born: GENESIS(0), _alive: true }),
    op(GENESIS(1), ME, `cat:${CAT[1]}`, { name: 'B', visible: true, _born: GENESIS(1), _alive: true }),
    op(GENESIS(2), ME, 'note:n1', { _born: GENESIS(2), date: '2026-05-01', text: 'a', categoryId: CAT[0], _alive: true }),
    op(GENESIS(3), ME, 'bar:b1', { _born: GENESIS(3), startDate: '2026-05-01', endDate: '2026-05-09', label: 'L', categoryId: CAT[0], _alive: true }),
    op(GENESIS(4), ME, 'pad:2026-05', { _born: GENESIS(4), text: 'notes', _alive: true }),
  ]);
  assert.equal(materialize(regs, soloCtx()).notes.length, 1);
  foldOps([
    op(m.tick(), ME, 'note:n1', { _alive: false }),
    op(m.tick(), ME, 'bar:b1', { _alive: false }),
    op(m.tick(), ME, 'pad:2026-05', { _alive: false }),
    op(m.tick(), ME, `cat:${CAT[1]}`, { _alive: false }),
  ], regs);
  const out = materialize(regs, soloCtx());
  assert.deepEqual(out.notes, []);
  assert.deepEqual(out.bars, []);
  assert.deepEqual(out.scratchpads, {});
  assert.deepEqual(out.categories.map((c) => c.id), [CAT[0]]);
});

test('a tombstone retains its content registers, so an undo resurrects the NEWEST text', () => {
  // ADR 001 §6: `_alive` is its own register. Delete at A, edit at B > A ⇒ dead with an unread
  // new text; the explicit `_alive:true` that undo emits brings the newest content back.
  const m = minter(DEV_A);
  const regs = foldOps([
    op(GENESIS(0), ME, 'note:n1', { _born: GENESIS(0), date: '2026-05-01', text: 'old', categoryId: CAT[0], _alive: true }),
  ]);
  const tDelete = m.tick();
  const tEdit = m.tick();
  foldOps([
    op(tDelete, ME, 'note:n1', { _alive: false }),
    op(tEdit, MAMA, 'note:n1', { text: 'new' }),
  ], regs);
  assert.deepEqual(materialize(regs, soloCtx()).notes, []);
  foldOps([op(m.tick(), ME, 'note:n1', { _alive: true })], regs);
  assert.equal(materialize(regs, soloCtx()).notes[0].text, 'new');
});

test('renderability is checked against explicit fields, never inferred from absence', () => {
  // UPDATED FOR A3-H2 (`entities.js:renderableNote` / `renderableBar`). The rule this row asserts
  // is unchanged for a FOREIGN entry and for the field that carries an own entry's CONTENT: a
  // note with no `text` is a fragment or a withdrawal (ADR 004 §5.1) and is not on the board.
  //
  // What changed is the DATE. An own entry's date decides which day row draws it, not whether it
  // exists — `state.notes` is v1's array, and v1 keeps a dateless note and a one-ended bar in
  // its arrays and simply never places them. v2 refused them, and in solo mode `board.json` is
  // the checkpoint, so the refusal was written back over the user's file on the first autosave.
  const regs = foldOps([
    // own note, no text yet — a fragment, not an empty note. STILL not on the board.
    op(GENESIS(0), ME, 'note:frag', { _born: GENESIS(0), date: '2026-05-01', _alive: true }),
    // own bar, one date only — v1 draws this to the far edge of the window, so it is on the board
    op(GENESIS(1), ME, 'bar:half', { _born: GENESIS(1), startDate: '2026-05-01', label: 'x', _alive: true }),
    // own note whose text is an EMPTY STRING — that is a value, and v1 renders it as "…"
    op(GENESIS(2), ME, 'note:empty', { _born: GENESIS(2), date: '2026-05-02', text: '', _alive: true }),
    // own bar with label '' — exactly what interact.js:307 creates
    op(GENESIS(3), ME, 'bar:fresh', { _born: GENESIS(3), startDate: '2026-05-01', endDate: '2026-05-03', label: '', _alive: true }),
    // own note with a TEXT and no date — v1's array holds it; no day row asks for it
    op(GENESIS(4), ME, 'note:nodate', { _born: GENESIS(4), text: 'Zahnarzt', _alive: true }),
  ]);
  const out = materialize(regs, soloCtx());
  assert.deepEqual(out.notes.map((n) => n.id), ['empty', 'nodate']);
  assert.deepEqual(out.bars.map((b) => b.id), ['half', 'fresh']);
  assert.equal(out.notes.find((n) => n.id === 'nodate').date, undefined, 'and no date was invented');
});

test('a Geteilt foreign note whose pub.text has not arrived is INVISIBLE, not "Belegt"', () => {
  // ADR 001 §5 step 3 / §13.6 — the single most important consequence of "no causal delivery".
  const k = familyKey('fnote', MAMA, 'u1');
  const regs = foldOps([
    op(GENESIS(0), MAMA, k, {
      _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01',
    }),
  ]);
  assert.deepEqual(materialize(regs, familyCtx()).notes, []);
  foldOps([op(fmt(1, 0, DEV_B), MAMA, k, { 'pub.text': 'Zahnarzt' })], regs);
  const out = materialize(regs, familyCtx());
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].text, 'Zahnarzt');
  assert.equal(out.notes[0].redacted, false);
});

test('a Belegt foreign note IS projected, carries no text, and is marked redacted', () => {
  const k = familyKey('fnote', MAMA, 'u2');
  const out = materialize(foldOps([
    op(GENESIS(0), MAMA, k, {
      _born: GENESIS(0), 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-05-01',
      'pub.repeatsYearly': false,
    }),
  ]), familyCtx());
  assert.equal(out.notes.length, 1);
  const n = out.notes[0];
  assert.equal(n.redacted, true);
  assert.equal('text' in n, false, 'a Belegt entry must carry no text field at all');
  assert.equal(n.level, 'belegt');
  assert.equal(n.isForeign, true);
  assert.equal(n.ownerId, MAMA);
  assert.equal(n.memberColorRef, 'magenta');
  assert.equal(n.initial, 'M');
});

test('a foreign entry at privat, or with no level at all, is not projected', () => {
  const regs = foldOps([
    op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'p1'), {
      _born: GENESIS(0), 'pub.level': 'privat', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'leak?',
    }),
    op(GENESIS(1), MAMA, familyKey('fnote', MAMA, 'p2'), {
      _born: GENESIS(1), 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'leak?',
    }),
  ]);
  assert.deepEqual(materialize(regs, familyCtx()).notes, []);
});

test('pub.alive:false removes a foreign entry (delete-while-published)', () => {
  const k = familyKey('fbar', MAMA, 'u3');
  const regs = foldOps([
    op(GENESIS(0), MAMA, k, {
      _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true,
      'pub.startDate': '2026-05-01', 'pub.endDate': '2026-05-09', 'pub.label': 'Urlaub',
    }),
  ]);
  assert.equal(materialize(regs, familyCtx()).bars.length, 1);
  foldOps([op(fmt(1, 0, DEV_B), MAMA, k, {
    'pub.alive': false, 'pub.startDate': null, 'pub.endDate': null, 'pub.label': null,
  })], regs);
  assert.deepEqual(materialize(regs, familyCtx()).bars, []);
});

test('a removed member\'s entries vanish instantly — no crypto, no purge op (20.2)', () => {
  const regs = foldOps([
    op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'u4'), {
      _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true,
      'pub.date': '2026-05-01', 'pub.text': 'Elternabend',
    }),
  ]);
  assert.equal(materialize(regs, familyCtx()).notes.length, 1);
  const removed = familyCtx({ currentMembers: new Set([ME, ADMIN]) });
  assert.deepEqual(materialize(regs, removed).notes, []);
});

test('a hidden member\'s entries are dropped (17.3) and reappear when unhidden', () => {
  const regs = foldOps([
    op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'u5'), {
      _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true,
      'pub.date': '2026-05-01', 'pub.text': 'Yoga',
    }),
  ]);
  assert.deepEqual(materialize(regs, familyCtx({ hiddenMembers: new Set([MAMA]) })).notes, []);
  assert.equal(materialize(regs, familyCtx({ hiddenMembers: new Set([ADMIN]) })).notes.length, 1);
});

test('solo mode is structurally untouched: no familySpaceId ⇒ no foreign entry can reach the board', () => {
  // ADR 001 §11. Even a register map that somehow carries family entries produces exactly the
  // v1 arrays when no family space is configured.
  const regs = foldOps([
    op(GENESIS(0), ME, 'note:mine', { _born: GENESIS(0), date: '2026-05-01', text: 'mine', _alive: true }),
    op(GENESIS(1), MAMA, familyKey('fnote', MAMA, 'u6'), {
      _born: GENESIS(1), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'hers',
    }),
  ]);
  const out = materialize(regs, soloCtx());
  assert.deepEqual(out.notes.map((n) => n.text), ['mine']);
  assert.equal(out.notes[0].isForeign, false);
});

test('MY OWN publication is never a second entry on my own board', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, 'note:u7', { _born: GENESIS(0), date: '2026-05-01', text: 'Zahnarzt', categoryId: CAT[0], _alive: true, visibility: 'geteilt' }),
    op(GENESIS(1), ME, familyKey('fnote', ME, 'u7'), {
      _born: GENESIS(1), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'Zahnarzt',
    }),
  ]);
  const out = materialize(regs, familyCtx());
  assert.equal(out.notes.length, 1);
  assert.equal(out.notes[0].isForeign, false);
  assert.equal(out.notes[0].id, 'u7');
});

test('a foreign entry that reuses one of my uuids does not collide with mine', () => {
  // Ownership is structural (ADR 001 §4.4), so a hostile member CAN mint fbar:mem_them/<my uuid>.
  // `id` must stay unique or assignLanes' Map collapses the two bars into one lane and every
  // id lookup becomes ambiguous.
  const regs = foldOps([
    op(GENESIS(0), ME, 'bar:dup', { _born: GENESIS(0), startDate: '2026-05-01', endDate: '2026-05-09', label: 'mine', categoryId: CAT[0], _alive: true }),
    op(GENESIS(1), MAMA, familyKey('fbar', MAMA, 'dup'), {
      _born: GENESIS(1), 'pub.level': 'geteilt', 'pub.alive': true,
      'pub.startDate': '2026-05-01', 'pub.endDate': '2026-05-09', 'pub.label': 'hers',
    }),
  ]);
  const out = materialize(regs, familyCtx());
  assert.equal(out.bars.length, 2);
  assert.equal(new Set(out.bars.map((b) => b.id)).size, 2, 'two entries share an id');
  const foreign = out.bars.find((b) => b.isForeign);
  assert.equal(foreign.id, `fbar:${MAMA}/dup`);
  assert.equal(foreign.uuid, 'dup');
  assert.equal(out.bars.find((b) => !b.isForeign).id, 'dup');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. PROMOTION — the correctness heart of ADR 004 (P7c)
// ═════════════════════════════════════════════════════════════════════════════

/** My own Geteilt, co-editable note plus the family record for it. */
function coEditedNote({ text = 'Zahnarzt', bornAt = GENESIS(0) } = {}) {
  const fk = familyKey('fnote', ME, 'ce');
  const regs = foldOps([
    op(bornAt, ME, 'note:ce', {
      _born: bornAt, date: '2026-05-01', text, categoryId: CAT[0],
      repeatsYearly: false, visibility: 'geteilt', coEdit: true, _alive: true,
    }),
    op(fmt(10, 0, DEV_A), ME, fk, {
      _born: fmt(10, 0, DEV_A), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.coEdit': true,
      'pub.date': '2026-05-01', 'pub.text': text, 'pub.repeatsYearly': false,
    }),
  ]);
  return { regs, fk };
}

test('PROMOTABLE is exactly the co-editable content fields — no governing field, no categoryId', () => {
  assert.deepEqual(PROMOTABLE.note, { 'pub.date': 'date', 'pub.text': 'text', 'pub.repeatsYearly': 'repeatsYearly' });
  assert.deepEqual(PROMOTABLE.bar, { 'pub.startDate': 'startDate', 'pub.endDate': 'endDate', 'pub.label': 'label' });
  for (const map of Object.values(PROMOTABLE)) {
    for (const [pubField, truthField] of Object.entries(map)) {
      assert.equal(FIELDS.note[truthField]?.coEdit ?? FIELDS.bar[truthField]?.coEdit, true);
      assert.notEqual(FIELDS.fnote[pubField]?.gov ?? FIELDS.fbar[pubField]?.gov, true);
      assert.doesNotMatch(pubField, /categor/i);
    }
  }
});

test('a co-editor\'s newer pub write is promoted onto my own entry (18.2)', () => {
  const { regs, fk } = coEditedNote();
  foldOps([op(fmt(20, 0, DEV_B), MAMA, fk, { 'pub.text': 'Zahnarzt 15:30', 'pub.date': '2026-05-02' })], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.text, 'Zahnarzt 15:30');
  assert.equal(n.date, '2026-05-02');
});

test('P7c — my OWN pub.* writes are never promoted: a Geteilt→Belegt downgrade does not blank my note', () => {
  // The single asymmetry ADR 004 §4.1 calls the correctness heart. `pub.text: null` at a stamp
  // greater than every truth stamp; if it were promoted, my own board would go blank.
  const { regs, fk } = coEditedNote({ text: 'Zahnarzt' });
  foldOps([
    op(fmt(30, 0, DEV_A), ME, 'note:ce', { visibility: 'belegt' }),
    op(fmt(30, 1, DEV_A), ME, fk, { 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null }),
  ], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.text, 'Zahnarzt');
  assert.equal(n.visibility, 'belegt');
  assert.equal(n.level, 'belegt');
});

test('P7c — a non-null pub write of my own at a newer stamp is not promoted either', () => {
  // A publication is a projection OF the truth. If it could write back, a republish loop would
  // become a merge participant and the truth would no longer be the truth.
  const { regs, fk } = coEditedNote({ text: 'Zahnarzt' });
  foldOps([op(fmt(40, 0, DEV_A), ME, fk, { 'pub.text': 'STALE COPY' })], regs);
  assert.equal(materialize(regs, familyCtx()).notes[0].text, 'Zahnarzt');
});

test('P7c — my OTHER Mac\'s publication write is not promoted either: author is the MEMBER', () => {
  // `Register.author` is `op.act`, the acting HUMAN, not the device. Were it the device, a
  // Geteilt→Belegt downgrade performed on my desktop would blank the note on my laptop — a
  // silent data-loss bug no single-device test could ever see. DEV_B here is MY second Mac:
  // same member, different device short.
  const { regs, fk } = coEditedNote({ text: 'Zahnarzt' });
  foldOps([op(fmt(40, 0, DEV_B), ME, fk, { 'pub.text': 'republished from my laptop' })], regs);
  assert.equal(materialize(regs, familyCtx()).notes[0].text, 'Zahnarzt');
});

test('a foreign entry at an UNKNOWN future level does not render as Geteilt', () => {
  // Forward compatibility, read side: a level this build has never heard of must not be treated
  // as the most permissive one it knows. With no pub.text it is invisible; with one it is not
  // marked redacted, and `board.js` branches on `redacted`, so it cannot silently print as a
  // Belegt block either.
  const k = familyKey('fnote', MAMA, 'lvl');
  const regs = foldOps([op(GENESIS(0), MAMA, k, {
    _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01',
  })]);
  regs.get(k).set('pub.level', { value: 'orange', stamp: fmt(9, 0, DEV_B), author: MAMA });
  assert.deepEqual(materialize(regs, familyCtx()).notes, [], 'an unknown level rendered without text');
  regs.get(k).set('pub.text', { value: 'x', stamp: fmt(9, 1, DEV_B), author: MAMA });
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.level, 'orange');
  assert.equal(n.redacted, false);
});

test('the member gate fails CLOSED — a ctx with no member information hides foreign entries', () => {
  // 20.2 is a privacy control. A malformed ctx must hide entries (visible, reportable) rather
  // than keep showing a removed member's (silent).
  const regs = foldOps([op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'fc'), {
    _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'x',
  })]);
  const naked = { me: ME, familySpaceId: 'fsp_0000000000000000000000', defaultSettings: V1_DEFAULT_SETTINGS };
  assert.deepEqual(materialize(regs, naked).notes, []);
  // and `members` alone is enough to open it
  assert.equal(materialize(regs, { ...naked, members: new Map([[MAMA, { colorRef: 'magenta', initial: 'M' }]]) }).notes.length, 1);
});

test('an ADMIN unshare nulls the publication and leaves my truth untouched (18.3, INV-R3)', () => {
  const { regs, fk } = coEditedNote({ text: 'Zahnarzt' });
  foldOps([op(fmt(50, 0, DEV_B), ADMIN, fk, {
    'pub.level': 'privat', 'pub.alive': false,
    'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null,
  })], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.text, 'Zahnarzt', 'a redaction must never make my own board lie to me');
  assert.equal(n.date, '2026-05-01');
  assert.equal(n.level, 'privat');
});

test('the truth wins when it is newer than the co-editor\'s pub write', () => {
  const { regs, fk } = coEditedNote({ text: 'Zahnarzt' });
  foldOps([
    op(fmt(20, 0, DEV_B), MAMA, fk, { 'pub.text': 'hers' }),
    op(fmt(21, 0, DEV_A), ME, 'note:ce', { text: 'mine, later' }),
  ], regs);
  assert.equal(materialize(regs, familyCtx()).notes[0].text, 'mine, later');
});

test('promotion is by STAMP, not by arrival — a late co-editor write with an older stamp loses', () => {
  const { regs, fk } = coEditedNote({ text: 'Zahnarzt' });
  foldOps([op(fmt(21, 0, DEV_A), ME, 'note:ce', { text: 'mine, later' })], regs);
  foldOps([op(fmt(20, 0, DEV_B), MAMA, fk, { 'pub.text': 'hers, earlier' })], regs);
  assert.equal(materialize(regs, familyCtx()).notes[0].text, 'mine, later');
});

test('a governing pub field is never promoted onto its truth counterpart', () => {
  // `pub.coEdit` and `coEdit` share a name; if promotion were name-based rather than
  // coEdit-flag-based, a co-editor could grant themselves co-edit (ADR 004 §8).
  const { regs, fk } = coEditedNote();
  foldOps([
    op(fmt(60, 0, DEV_A), ME, 'note:ce', { coEdit: false, visibility: 'geteilt' }),
    op(fmt(61, 0, DEV_B), MAMA, fk, { 'pub.coEdit': true, 'pub.level': 'geteilt' }),
  ], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.coEdit, false, 'pub.coEdit was promoted onto the truth register');
  assert.equal(n.visibility, 'geteilt');
});

test('a stray pub.categoryId register can never reach a rendered entry (A3)', () => {
  // Not producible by validateOp — which is why the read-side allowlist is worth its one line.
  const fk = familyKey('fnote', MAMA, 'a3');
  const regs = foldOps([
    op(GENESIS(0), MAMA, fk, {
      _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true,
      'pub.date': '2026-05-01', 'pub.text': 'x',
    }),
  ]);
  regs.get(fk).set('pub.categoryId', { value: CAT[1], stamp: fmt(99, 0, DEV_B), author: MAMA });
  regs.get(fk).set('categoryId', { value: CAT[2], stamp: fmt(99, 1, DEV_B), author: MAMA });
  regs.get(fk).set('text', { value: 'SECRET TRUTH', stamp: fmt(99, 2, DEV_B), author: MAMA });
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal('categoryId' in n, false);
  assert.equal('pub.categoryId' in n, false);
  assert.equal(n.text, 'x', 'an undeclared truth register on a family key reached the entry');
});

test('no foreign entry ever carries a category field, at any level', () => {
  const regs = emptyRegisters();
  for (const [i, level] of ['belegt', 'geteilt'].entries()) {
    foldOps([op(GENESIS(i), MAMA, familyKey('fnote', MAMA, `c${i}`), {
      _born: GENESIS(i), 'pub.level': level, 'pub.alive': true,
      'pub.date': '2026-05-01', 'pub.repeatsYearly': false,
      ...(level === 'geteilt' ? { 'pub.text': 't' } : {}),
    })], regs);
  }
  const out = materialize(regs, familyCtx());
  assert.ok(out.notes.length >= 1);
  for (const n of out.notes.filter((x) => x.isForeign)) {
    for (const k of Object.keys(n)) assert.doesNotMatch(k, /categor/i);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// D. CONVERGENCE — reorder, duplicate, partition, late delivery
// ═════════════════════════════════════════════════════════════════════════════

/** A dense, adversarial op stream touching every kind, with deliberate stamp collisions. */
function chaosOps() {
  const a = minter(DEV_A, 1000);
  const b = minter(DEV_B, 1000);
  const ops = [];
  for (let i = 0; i < 4; i++) {
    ops.push(op(GENESIS(i), ME, `cat:${CAT[i]}`, {
      name: `C${i}`, nameEn: `C${i}`, paletteRef: 'blau', visible: i !== 2,
      defaultVisibility: 'privat', _alive: true, _born: GENESIS(i),
    }));
  }
  for (let i = 0; i < 6; i++) {
    const born = GENESIS(10 + i);
    ops.push(op(born, ME, `note:n${i}`, {
      _born: born, date: `2026-0${(i % 9) + 1}-1${i}`, text: `t${i}`,
      categoryId: CAT[i % 4], repeatsYearly: i % 3 === 0,
      visibility: 'privat', coEdit: false, _alive: true,
    }));
    ops.push(op(a.tick(), ME, `note:n${i}`, { text: `t${i} edited` }));
    if (i % 2) ops.push(op(b.tick(), ME, `note:n${i}`, { date: `2026-07-0${(i % 9) + 1}` }));
  }
  for (let i = 0; i < 4; i++) {
    const born = GENESIS(30 + i);
    ops.push(op(born, ME, `bar:b${i}`, {
      _born: born, startDate: `2026-02-0${i + 1}`, endDate: `2026-0${i + 3}-01`,
      label: `L${i}`, categoryId: CAT[i % 4],
      visibility: 'privat', coEdit: false, _alive: true,
    }));
    ops.push(op(a.tick(), ME, `bar:b${i}`, { endDate: `2026-0${i + 4}-01` }));
  }
  ops.push(op(a.tick(), ME, 'note:n2', { _alive: false }));
  ops.push(op(b.tick(), ME, 'note:n2', { text: 'edited after delete' }));
  ops.push(op(GENESIS(50), ME, 'pad:2026-03', { _born: GENESIS(50), text: 'Milch', _alive: true }));
  ops.push(op(GENESIS(51), ME, 'pad:2026-01', { _born: GENESIS(51), text: 'Vorsätze', _alive: true }));
  ops.push(op(a.tick(), ME, 'pad:2026-01', { text: 'Vorsätze 2' }));
  ops.push(op(a.tick(), ME, PREF_ENTITY, flattenPref({ mode: 'pinned', startMonth: '2026-01', layers: { schulferien: true } })));
  ops.push(op(b.tick(), ME, PREF_ENTITY, flattenPref({ rowHeight: 30 })));

  // Family traffic: two owners, a co-editor, a downgrade and an unshare.
  const mine = familyKey('fnote', ME, 'n0');
  ops.push(op(a.tick(), ME, mine, {
    _born: a.tick(), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.coEdit': true,
    'pub.date': '2026-01-10', 'pub.text': 't0 edited', 'pub.repeatsYearly': true,
  }));
  ops.push(op(b.tick(), MAMA, mine, { 'pub.text': 't0 co-edited' }));
  for (const [i, level] of ['geteilt', 'belegt', 'geteilt'].entries()) {
    const k = familyKey('fnote', MAMA, `m${i}`);
    const born = GENESIS(60 + i);
    ops.push(op(born, MAMA, k, {
      _born: born, 'pub.level': level, 'pub.alive': true,
      'pub.date': `2026-0${i + 2}-14`, 'pub.repeatsYearly': false,
      ...(level === 'geteilt' ? { 'pub.text': `mama ${i}` } : {}),
    }));
  }
  const bk = familyKey('fbar', ADMIN, 'ab');
  ops.push(op(GENESIS(70), ADMIN, bk, {
    _born: GENESIS(70), 'pub.level': 'geteilt', 'pub.alive': true,
    'pub.startDate': '2026-03-01', 'pub.endDate': '2026-04-01', 'pub.label': 'Oma',
  }));
  ops.push(op(b.tick(), ADMIN, familyKey('fnote', MAMA, 'm2'), {
    'pub.level': 'privat', 'pub.alive': false, 'pub.date': null, 'pub.text': null,
    'pub.repeatsYearly': null, 'pub.coEdit': null,
  }));
  return ops;
}

test('P1 — reorder-invariance: 200 shuffles of the same op set materialize byte-identically', () => {
  const ops = chaosOps();
  const ref = J(materialize(foldOps(ops), familyCtx()));
  for (let seed = 1; seed <= 200; seed++) {
    const got = J(materialize(foldOps(shuffled(ops, mulberry32(seed))), familyCtx()));
    assert.equal(got, ref, `divergence at seed ${seed}`);
  }
});

test('P2 — duplicate delivery changes nothing, at any multiplicity', () => {
  const ops = chaosOps();
  const ref = J(materialize(foldOps(ops), familyCtx()));
  for (const mult of [2, 3, 5]) {
    const dup = [];
    for (const o of ops) for (let i = 0; i < mult; i++) dup.push({ ...o });
    assert.equal(J(materialize(foldOps(shuffled(dup, mulberry32(mult))), familyCtx())), ref);
  }
});

test('interleave / partition: any split folded in any order lands on the same state', () => {
  // The checkpoint property (ADR 001 §7.2) at the materialization layer: fold(A) then fold(B)
  // equals fold(A ∪ B) for EVERY partition, including one that puts newer ops in the first half.
  const ops = chaosOps();
  const ref = J(materialize(foldOps(ops), familyCtx()));
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = mulberry32(seed);
    const s = shuffled(ops, rnd);
    const cut = Math.floor(rnd() * s.length);
    const regs = foldOps(s.slice(0, cut));
    foldOps(s.slice(cut), regs);
    assert.equal(J(materialize(regs, familyCtx())), ref, `partition ${seed} diverged`);
  }
});

test('checkpoint + tail: mergeMaps(fold(prefix), fold(tail)) materializes as fold(all) does', () => {
  // ADR 001 §7.2 — compaction is free of coordination precisely because per-field stamps are
  // RETAINED, so a late op older than the horizon is compared against the checkpoint's stamp and
  // wins or loses by the identical rule. Asserted at the level a user would notice: the board.
  const ops = chaosOps();
  const ref = J(materialize(foldOps(ops), familyCtx()));
  for (let seed = 1; seed <= 15; seed++) {
    const rnd = mulberry32(seed);
    const s = shuffled(ops, rnd);
    const cut = Math.floor(rnd() * s.length);
    const checkpoint = foldOps(s.slice(0, cut));
    const tail = foldOps(s.slice(cut));
    assert.equal(J(materialize(mergeMaps(checkpoint, tail), familyCtx())), ref);
    assert.equal(J(materialize(mergeMaps(tail, checkpoint), familyCtx())), ref, 'mergeMaps is not commutative here');
  }
});

test('a three-weeks-late op is absorbed, never applied over a newer one (19.6, monotone reads)', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, 'note:late', { _born: GENESIS(0), date: '2026-05-01', text: 'v1', categoryId: CAT[0], _alive: true }),
    op(fmt(9_000, 0, DEV_A), ME, 'note:late', { text: 'v2' }),
  ]);
  const before = J(materialize(regs, soloCtx()));
  // The straggler: authored earlier, delivered now.
  foldOps([op(fmt(5_000, 0, DEV_B), MAMA, 'note:late', { text: 'from the train' })], regs);
  assert.equal(J(materialize(regs, soloCtx())), before);
  // and an op that genuinely wins does apply
  foldOps([op(fmt(9_001, 0, DEV_B), MAMA, 'note:late', { text: 'v3' })], regs);
  assert.equal(materialize(regs, soloCtx()).notes[0].text, 'v3');
});

test('concurrent move + edit of the same note converge to BOTH applied (18.5)', () => {
  const base = [op(GENESIS(0), ME, 'note:x', { _born: GENESIS(0), date: '2026-05-01', text: 'old', categoryId: CAT[0], _alive: true })];
  const a = op(fmt(100, 0, DEV_A), ME, 'note:x', { date: '2026-06-01' });
  const b = op(fmt(100, 0, DEV_B), MAMA, 'note:x', { text: 'new' });
  const one = materialize(foldOps([...base, a, b]), soloCtx()).notes[0];
  const two = materialize(foldOps([...base, b, a]), soloCtx()).notes[0];
  assert.deepEqual(one, two);
  assert.equal(one.date, '2026-06-01');
  assert.equal(one.text, 'new');
});

test('the delete-category fan-out converges under PARTIAL delivery (legend.js:197)', () => {
  // N reassign ops + the tombstone, one gid, no cross-device atomicity. A half-delivered group
  // must leave a consistent board, and the rest must land on the same state.
  const born = (i) => GENESIS(i);
  const setup = [
    op(born(0), ME, `cat:${CAT[0]}`, { name: 'A', visible: true, _alive: true, _born: born(0) }),
    op(born(1), ME, `cat:${CAT[1]}`, { name: 'B', visible: true, _alive: true, _born: born(1) }),
  ];
  for (let i = 0; i < 5; i++) {
    setup.push(op(born(10 + i), ME, `note:f${i}`, {
      _born: born(10 + i), date: '2026-05-01', text: `f${i}`, categoryId: CAT[0], _alive: true,
    }));
  }
  const m = minter(DEV_A, 2000);
  const fanout = [];
  for (let i = 0; i < 5; i++) fanout.push(op(m.tick(), ME, `note:f${i}`, { categoryId: CAT[1] }));
  fanout.push(op(m.tick(), ME, `cat:${CAT[0]}`, { _alive: false }));

  // Half delivered: the tombstone arrived, two reassigns did not. Step 7 repairs the dangling
  // reference to categories[0] — which is CAT[1], the only survivor — so nothing is orphaned.
  const partial = foldOps([...setup, ...fanout.slice(0, 3), fanout[5]]);
  const half = materialize(partial, soloCtx());
  assert.deepEqual(half.categories.map((c) => c.id), [CAT[1]]);
  for (const n of half.notes) assert.equal(n.categoryId, CAT[1]);

  // The rest arrives, in the worst order.
  foldOps(shuffled([...fanout, ...setup], mulberry32(3)), partial);
  assert.equal(J(materialize(partial, soloCtx())), J(materialize(foldOps([...setup, ...fanout]), soloCtx())));
});

test('materialize never mutates the register map, and is idempotent', () => {
  const regs = foldOps(chaosOps());
  const snapshot = J([...regs].map(([e, c]) => [e, [...c]]));
  const first = materialize(regs, familyCtx());
  const second = materialize(regs, familyCtx());
  assert.equal(J([...regs].map(([e, c]) => [e, [...c]])), snapshot, 'materialize mutated regs');
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'each call must return a fresh object');
  assert.notEqual(first.notes, second.notes);
});

test('a Register with only {value, stamp, author} is enough — no hidden field is required', () => {
  const rich = foldOps(chaosOps());
  assert.equal(J(materialize(bareRegisters(rich), familyCtx())), J(materialize(rich, familyCtx())));
});

test('an entity key that is not a well-formed key is ignored, not crashed on', () => {
  const regs = foldOps([op(GENESIS(0), ME, 'note:ok', { _born: GENESIS(0), date: '2026-05-01', text: 'x', _alive: true })]);
  regs.set('garbage', new Map([['text', { value: 'x', stamp: GENESIS(1), author: ME }]]));
  regs.set('fnote:not-a-member/u', new Map([['pub.level', { value: 'geteilt', stamp: GENESIS(2), author: MAMA }]]));
  regs.set('', new Map());
  const out = materialize(regs, familyCtx());
  assert.deepEqual(out.notes.map((n) => n.id), ['ok']);
});

// ═════════════════════════════════════════════════════════════════════════════
// E. STEP 5 — the deterministic sorts
// ═════════════════════════════════════════════════════════════════════════════

test('notes sort by (_born asc, id asc)', () => {
  const mk = (id, born) => op(born, ME, `note:${id}`, { _born: born, date: '2026-05-01', text: id, _alive: true });
  const ops = [mk('b', GENESIS(2)), mk('a', GENESIS(1)), mk('z', GENESIS(1)), mk('c', GENESIS(0))];
  assert.deepEqual(materialize(foldOps(ops), soloCtx()).notes.map((n) => n.id), ['c', 'a', 'z', 'b']);
});

test('bars sort by (_born asc, id asc) — v1 FILE ORDER, exactly like notes (ATT-50/ATT-52)', () => {
  // WAS `(startDate asc, endDate desc, id asc)`. That threw away the v1 array index `_born`
  // carries (ADR 001 §8.1) and made ADR 001 §8.3's acceptance criterion — "deep-equals the v1
  // board for every field INCLUDING array order" — FALSE for every board whose bars are not
  // already in date order. `assignLanes` re-sorts by the date comparator internally
  // (`layout.js:38-44`), so nothing about lane assignment depends on this.
  //
  // The dates below are the OPPOSITE of the `_born` order on purpose: under the old comparator
  // this test reads ['z', 'a', 'b', 'm'], so it cannot pass by accident under either rule.
  const mk = (id, born, s, e) => op(born, ME, `bar:${id}`, { _born: born, startDate: s, endDate: e, label: id, _alive: true });
  const ops = [
    mk('m', GENESIS(0), '2026-02-01', '2026-02-10'),
    mk('a', GENESIS(1), '2026-02-01', '2026-03-10'),
    mk('z', GENESIS(2), '2026-01-01', '2026-01-02'),
    mk('b', GENESIS(3), '2026-02-01', '2026-02-10'),
  ];
  assert.deepEqual(materialize(foldOps(ops), soloCtx()).bars.map((b) => b.id), ['m', 'a', 'z', 'b']);
  // …and it is order-independent, which is the half the date comparator also had.
  for (let seed = 1; seed <= 20; seed++) {
    assert.deepEqual(
      materialize(foldOps(shuffled(ops, mulberry32(seed))), soloCtx()).bars.map((b) => b.id),
      ['m', 'a', 'z', 'b'], `seed ${seed}`);
  }
  // A bar whose `_born` has not arrived sorts LAST, like a note fragment, and `id` is the total
  // final tiebreak.
  const frag = op(fmt(9, 0, DEV_B), ME, 'bar:frag', { startDate: '2026-01-01', endDate: '2026-01-02', _alive: true });
  const tie = mk('aa', GENESIS(0), '2026-05-01', '2026-05-02');
  assert.deepEqual(
    materialize(foldOps([...ops, frag, tie]), soloCtx()).bars.map((b) => b.id),
    ['aa', 'm', 'a', 'z', 'b', 'frag']);
});

test('categories[0] — the dangling-reference fallback — is deterministic', () => {
  const mk = (id, born) => op(born, ME, `cat:${id}`, { name: id, visible: true, _born: born, _alive: true });
  const ops = [mk('zz', GENESIS(1)), mk('aa', GENESIS(0)), mk('mm', GENESIS(1))];
  for (let seed = 1; seed <= 20; seed++) {
    const out = materialize(foldOps(shuffled(ops, mulberry32(seed))), soloCtx());
    assert.deepEqual(out.categories.map((c) => c.id), ['aa', 'mm', 'zz']);
  }
});

test('an entity whose _born has not arrived sorts LAST and never displaces a complete one', () => {
  // No causal delivery (ADR 001 §2): a fragment can exist. It must not win the capacity slice
  // over a fully-delivered entry.
  const ops = [
    op(GENESIS(5), ME, 'note:complete', { _born: GENESIS(5), date: '2026-05-01', text: 'c', _alive: true }),
    op(fmt(1, 0, DEV_B), ME, 'note:fragment', { date: '2026-05-01', text: 'f', _alive: true }),
  ];
  assert.deepEqual(materialize(foldOps(ops), soloCtx()).notes.map((n) => n.id), ['complete', 'fragment']);
});

test('scratchpad keys are emitted in sorted order, so JSON.stringify is stable', () => {
  const ops = ['2026-12', '2026-01', '2025-07', '2026-03'].map((k, i) =>
    op(GENESIS(i), ME, `pad:${k}`, { _born: GENESIS(i), text: k, _alive: true }));
  for (let seed = 1; seed <= 20; seed++) {
    const out = materialize(foldOps(shuffled(ops, mulberry32(seed))), soloCtx());
    assert.deepEqual(Object.keys(out.scratchpads), ['2025-07', '2026-01', '2026-03', '2026-12']);
  }
});

test('an emptied scratchpad drops its key entirely — v1 deletes it, it does not blank it', () => {
  const regs = foldOps([op(GENESIS(0), ME, 'pad:2026-03', { _born: GENESIS(0), text: 'Milch', _alive: true })]);
  assert.deepEqual(materialize(regs, soloCtx()).scratchpads, { '2026-03': 'Milch' });
  foldOps([op(fmt(1, 0, DEV_A), ME, 'pad:2026-03', { _alive: false })], regs);
  assert.deepEqual(materialize(regs, soloCtx()).scratchpads, {});
  assert.equal('2026-03' in materialize(regs, soloCtx()).scratchpads, false);
});

test('foreign entries take part in the same sort as my own — 17.4 depends on it', () => {
  // Story 17.4: foreign notes must hit the capacity slice and be counted into "+n". They cannot
  // do that from a separate array, and they cannot do it if the sort is unstable across devices.
  const ops = [
    op(GENESIS(1), ME, 'note:mine', { _born: GENESIS(1), date: '2026-05-01', text: 'mine', _alive: true }),
    op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'hers'), {
      _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'hers',
    }),
    op(GENESIS(2), ADMIN, familyKey('fnote', ADMIN, 'omas'), {
      _born: GENESIS(2), 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-05-01',
    }),
  ];
  for (let seed = 1; seed <= 20; seed++) {
    const out = materialize(foldOps(shuffled(ops, mulberry32(seed))), familyCtx());
    assert.deepEqual(out.notes.map((n) => n.uuid), ['hers', 'mine', 'omas']);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// F. STEP 7 — reference repair
// ═════════════════════════════════════════════════════════════════════════════

test('a note pointing at a deleted category is repaired to categories[0] (store.js:82-88)', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, `cat:${CAT[0]}`, { name: 'A', visible: true, _born: GENESIS(0), _alive: true }),
    op(GENESIS(1), ME, `cat:${CAT[1]}`, { name: 'B', visible: true, _born: GENESIS(1), _alive: true }),
    op(GENESIS(2), ME, 'note:n', { _born: GENESIS(2), date: '2026-05-01', text: 'x', categoryId: CAT[1], _alive: true }),
    op(GENESIS(3), ME, 'bar:b', { _born: GENESIS(3), startDate: '2026-05-01', endDate: '2026-05-02', label: 'y', categoryId: CAT[1], _alive: true }),
  ]);
  assert.equal(materialize(regs, soloCtx()).notes[0].categoryId, CAT[1]);
  foldOps([op(fmt(1, 0, DEV_A), ME, `cat:${CAT[1]}`, { _alive: false })], regs);
  const out = materialize(regs, soloCtx());
  assert.equal(out.notes[0].categoryId, CAT[0]);
  assert.equal(out.bars[0].categoryId, CAT[0]);
  assert.equal(out.settings.lastCategoryId, CAT[0]);
});

test('the repair is a projection invariant — it never writes back to the registers', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, `cat:${CAT[0]}`, { name: 'A', visible: true, _born: GENESIS(0), _alive: true }),
    op(GENESIS(1), ME, 'note:n', { _born: GENESIS(1), date: '2026-05-01', text: 'x', categoryId: 'ghost', _alive: true }),
  ]);
  assert.equal(materialize(regs, soloCtx()).notes[0].categoryId, CAT[0]);
  assert.equal(regs.get('note:n').get('categoryId').value, 'ghost', 'the log was rewritten');
  // …and it is idempotent: materializing twice gives the same answer.
  assert.equal(materialize(regs, soloCtx()).notes[0].categoryId, CAT[0]);
});

test('the repair never touches a foreign entry (A3)', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, `cat:${CAT[0]}`, { name: 'A', visible: true, _born: GENESIS(0), _alive: true }),
    op(GENESIS(1), MAMA, familyKey('fnote', MAMA, 'f'), {
      _born: GENESIS(1), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'hers',
    }),
  ]);
  const foreign = materialize(regs, familyCtx()).notes.find((n) => n.isForeign);
  assert.equal('categoryId' in foreign, false, 'a foreign entry was given one of MY categories');
});

test('a board with no live categories repairs nothing and does not crash', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, 'note:n', { _born: GENESIS(0), date: '2026-05-01', text: 'x', categoryId: 'ghost', _alive: true }),
  ]);
  const out = materialize(regs, soloCtx());
  assert.deepEqual(out.categories, []);
  assert.equal(out.notes[0].categoryId, 'ghost');
  assert.equal(out.settings.lastCategoryId, V1_DEFAULT_SETTINGS.lastCategoryId);
});

// ═════════════════════════════════════════════════════════════════════════════
// G. STEP 6 — settings
// ═════════════════════════════════════════════════════════════════════════════

test('dotted pref registers rebuild the nested v1 settings object', () => {
  const regs = foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, flattenPref({
      mode: 'pinned', startMonth: '2026-01', rowHeight: 30, bundesland: 'BY',
      layers: { feiertage: false, schulferien: true },
    })),
  ]);
  const s = materialize(regs, soloCtx()).settings;
  assert.equal(s.mode, 'pinned');
  assert.equal(s.startMonth, '2026-01');
  assert.equal(s.rowHeight, 30);
  assert.equal(s.bundesland, 'BY');
  assert.deepEqual(s.layers, { feiertage: false, schulferien: true, otherStates: false, ferienPattern: false });
});

test('layers are merged over the defaults one level deep — store.js:76-80 verbatim', () => {
  // A board written before `ferienPattern` existed must still get it, rather than losing every
  // layer key the prefs happen not to mention.
  const regs = foldOps([op(GENESIS(0), ME, PREF_ENTITY, { 'layers.feiertage': false })]);
  const s = materialize(regs, soloCtx()).settings;
  assert.deepEqual(Object.keys(s.layers).sort(),
    Object.keys(defaultState().settings.layers).sort());
  assert.equal(s.layers.feiertage, false);
  assert.equal(s.layers.ferienPattern, false);
});

test("a cleared pref takes v1's reading of null — the default, or false where v1 reads a boolean", () => {
  // `rowHeight` is v1's `layout.js:92` `s.rowHeight || 22`, so v1's reading of a null rowHeight
  // IS 22. `replace.js:buildPrefOp` also writes exactly this null to mean "the imported file does
  // not carry rowHeight, revert to the default" (ATT-32 / ADR 001 §8.5 step 5), and the two
  // readings coincide — which is why nothing here changes for a pref like this one.
  const regs = foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, { rowHeight: 30 }),
    op(fmt(1, 0, DEV_A), ME, PREF_ENTITY, { rowHeight: null }),
  ]);
  assert.equal(materialize(regs, soloCtx()).settings.rowHeight, 22);

  // REG-8 — A PREF v1 READS AS A BOOLEAN IS `false` WHEN IT IS NULL, NOT THE DEFAULT.
  // `store.js:76-80` is a spread, so `layers.feiertage: null` reaches `state.settings` intact and
  // `layout.js:104`'s `s.layers.feiertage ?` reads it as OFF. Falling back to
  // `defaultState()`'s `true` turned the layer back ON on upgrade day, silently, and the next
  // export wrote `true` into the user's file. Same for `menuBarIcon` (`main.js:320`, `!!`).
  const off = foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, { 'layers.feiertage': true, menuBarIcon: true, paper: 'a3' }),
    op(fmt(1, 0, DEV_A), ME, PREF_ENTITY, { 'layers.feiertage': null, menuBarIcon: null, paper: null }),
  ]);
  const s = materialize(off, soloCtx()).settings;
  assert.equal(s.layers.feiertage, false, 'the Feiertage layer flipped ON — REG-8 is back');
  assert.equal(s.menuBarIcon, false, 'the menu-bar icon came back — REG-8 is back');
  assert.equal(s.paper, 'a4', "`print.js:25` is `s.paper || 'a4'`, so v1's reading is the default");
  // The other three layers are untouched: this reads a CLEARED register, not every boolean.
  assert.deepEqual(s.layers, { feiertage: false, schulferien: false, otherStates: false, ferienPattern: false });
  assert.equal(materialize(foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, { 'layers.otherStates': true }),
  ]), soloCtx()).settings.layers.otherStates, true, 'a pref that CARRIES true still says true');

  // A cleared pref with NO default is still absent — there is no v1 reader and nothing to
  // reproduce, and `settings.hiddenMembers` must not spring into existence as an empty object.
  const extra = materialize(foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, { density: null, [`hiddenMembers.${MAMA}`]: null }),
  ]), soloCtx()).settings;
  assert.equal('density' in extra, false);
  assert.equal('hiddenMembers' in extra, false);
});

test('a pref NAME nested past the cap is dropped by the projection, whatever wrote it', () => {
  // THE SECOND LOCK on `ops.js:PREF_MAX_DEPTH`, and the only test that can reach it: `flattenPref`
  // refuses to MINT a name this deep, so neither door can produce one. A `checkpoint.json` is
  // deserialised straight into the register map with no admissibility fold at all (F-5) and a
  // peer's `pref.set` arrives already flattened — both bypass the mint-side cap entirely, which
  // is why the cap alone is not the whole fix.
  //
  // The rebuild in `prefsFromRegisters` is iterative and survives ANY depth. What does not is
  // `store._project`'s `structuredClone(this.state.settings)` one layer up: a name with a couple
  // of thousand dots becomes a couple of thousand levels of object and the clone overflows the
  // stack — outside every door, out of `init()`, with `ready === false`. So the name is dropped
  // here, which is the same call the `mode`-and-`mode.x` comment in that function already makes:
  // keep the board, lose one pref.
  const deepName = `deepThing${'.k'.repeat(4000)}.leaf`;
  const regs = foldOps([op(GENESIS(0), ME, PREF_ENTITY, { [deepName]: 1, rowHeight: 30 })]);
  const s = materialize(regs, soloCtx()).settings;
  assert.equal('deepThing' in s, false, 'the unrepresentable name is not in settings');
  assert.equal(s.rowHeight, 30, 'and it costs one NAME, not the settings object');
  assert.doesNotThrow(() => structuredClone(s),
    'the whole point: what the projection hands out has to survive the clone the store does on it');

  // The boundary, both sides of it, so the cap cannot drift without a red row.
  const at = `a${'.b'.repeat(31)}`;                                   // 32 segments = depth 31
  const past = `a${'.b'.repeat(32)}.c`;                               // 34 segments
  const sAt = materialize(foldOps([op(GENESIS(0), ME, PREF_ENTITY, { [at]: 1 })]), soloCtx()).settings;
  const sPast = materialize(foldOps([op(GENESIS(0), ME, PREF_ENTITY, { [past]: 1 })]), soloCtx()).settings;
  assert.equal('a' in sAt, true, 'a name AT the cap is still a pref');
  assert.equal('a' in sPast, false, 'a name past it is not');
});

test('settings key order is deterministic across arrival orders (board.json is byte-compared)', () => {
  const ops = [
    op(GENESIS(0), ME, PREF_ENTITY, { zzz: 1 }),
    op(GENESIS(1), ME, PREF_ENTITY, { aaa: 2 }),
    op(GENESIS(2), ME, PREF_ENTITY, { mmm: 3 }),
    op(GENESIS(3), ME, PREF_ENTITY, flattenPref({ mode: 'pinned', layers: { schulferien: true } })),
  ];
  const ref = J(materialize(foldOps(ops), soloCtx()).settings);
  for (let seed = 1; seed <= 30; seed++) {
    assert.equal(J(materialize(foldOps(shuffled(ops, mulberry32(seed))), soloCtx()).settings), ref);
  }
  // and the defaults keep v1's own key order, with the extras appended in sorted order
  const keys = Object.keys(materialize(foldOps(ops), soloCtx()).settings);
  assert.deepEqual(keys.slice(0, Object.keys(DEFAULT_SETTINGS).length), Object.keys(DEFAULT_SETTINGS));
  assert.deepEqual(keys.slice(Object.keys(DEFAULT_SETTINGS).length), ['aaa', 'mmm', 'zzz']);
});

test('the v2 device-local prefs survive the round trip as nested objects', () => {
  // ADR 001 §3.3's `lastSeenSeq` map and `hiddenMembers` set, carried as dotted keys because `f`
  // is scalars-only. See the report accompanying this package: §3.3 calls hiddenMembers an ARRAY,
  // and a dotted round trip necessarily yields an object. Pinned here so the difference is a
  // decision rather than a surprise.
  const regs = foldOps([op(GENESIS(0), ME, PREF_ENTITY, {
    deviceId: 'dev_zzzzzzzzzzzzzzzzzzzzzz',
    'lastSeenSeq.fsp_0000000000000000000000': '412',
    [`hiddenMembers.${MAMA}`]: true,
    density: 'compact',
  })]);
  const s = materialize(regs, soloCtx()).settings;
  assert.equal(s.deviceId, 'dev_zzzzzzzzzzzzzzzzzzzzzz');
  assert.deepEqual(s.lastSeenSeq, { fsp_0000000000000000000000: '412' });
  assert.deepEqual(s.hiddenMembers, { [MAMA]: true });
  assert.equal(s.density, 'compact');
});

test('a scalar and a branch on the same pref path keeps the scalar rather than throwing', () => {
  // One malformed pref must not make the app unbootable.
  const regs = foldOps([op(GENESIS(0), ME, PREF_ENTITY, { mode: 'pinned', 'mode.x': 1 })]);
  assert.equal(materialize(regs, soloCtx()).settings.mode, 'pinned');
});

test('ATT-30 — "no Bundesland ⇒ schulferien off" (7.5) IS a projection invariant', () => {
  // This test used to assert the opposite, on the reasoning that `store.js:89-91` lives in v1's
  // `migrate()`, which runs once per load, so re-applying it on every projection would be
  // CHANGING v1 rather than reproducing it. That reasoning was wrong about v1: `replaceAll()`
  // runs `migrate()` on every incoming board, so v1 re-normalises on every import (11.3) and
  // every snapshot restore (11.5). Leaving it out meant a shipped v1 invariant survived until
  // the first import and was then gone forever — which is a silent regression, not a decision.
  //
  // Idempotence is why it is safe as a projection invariant: `layout.js:107` skips `ferienIndex`
  // without a Bundesland anyway, so the layer could only ever have rendered as a pressed toggle
  // shading nothing.
  const regs = foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, flattenPref({ bundesland: '', layers: { schulferien: true } })),
    op(GENESIS(1), ME, `cat:${CAT[0]}`, { name: 'A', visible: true, _born: GENESIS(1), _alive: true }),
  ]);
  const out = materialize(regs, soloCtx());
  assert.equal(out.settings.layers.schulferien, false, 'store.js:89-91, on every projection');
  assert.equal(out.settings.bundesland, '');
  // …and it touches NOTHING else: the other three layers keep whatever the prefs said.
  const loud = foldOps([op(GENESIS(0), ME, PREF_ENTITY, flattenPref({
    bundesland: '', layers: { feiertage: false, schulferien: true, otherStates: true, ferienPattern: true },
  }))]);
  assert.deepEqual(materialize(loud, soloCtx()).settings.layers,
    { feiertage: false, schulferien: false, otherStates: true, ferienPattern: true });
  // With a Bundesland the layer is left exactly as authored — the normalisation is conditional,
  // not a permanent "off".
  const withState = foldOps([op(GENESIS(0), ME, PREF_ENTITY, flattenPref({
    bundesland: 'BY', layers: { schulferien: true },
  }))]);
  assert.equal(materialize(withState, soloCtx()).settings.layers.schulferien, true);

  // `store.js:88`'s paletteRef backfill is still NOT reproduced — it needs `palette.js`, which
  // is outside `core/` (ADR 005 §2). Still an absence, still the retrofit's job.
  assert.equal('paletteRef' in out.categories[0], false);
});

test('REG-9 — the three date primitives the hang guard is built on are dates.js, verbatim', () => {
  // `pinnedMonthsRenderable` reproduces `layout.js:visibleStart` and `layout.js:98-103`. It can
  // only do that if `dow`, `monthOrdinal` and `addMonths` in core/entities.js ARE the v1 ones —
  // `core/` may not import a v1 module (ADR 005 §2), so they are copies, and this is their pin.
  // core-ops.test.js pins the older primitives the same way; these three arrived with REG-9.
  for (const [y, m] of [[2026, 1], [2026, 13], [2026, 0], [26, 1], [0, 1], [1999, 12], [2000, 6]]) {
    for (const n of [-24, -13, -1, 0, 1, 11, 12, 25]) {
      assert.deepEqual(addMonths(y, m, n), v1dates.addMonths(y, m, n), `addMonths(${y},${m},${n})`);
    }
    assert.equal(monthOrdinal(y, m), v1dates.monthOrdinal(y, m), `monthOrdinal(${y},${m})`);
  }
  for (let y = 1998; y <= 2042; y++) {
    for (const [m, d] of [[1, 1], [2, 29], [11, 22], [12, 31]]) {
      assert.equal(dow(y, m, d), v1dates.dow(y, m, d), `dow(${y},${m},${d})`);
    }
  }
  // …and the copies agree on the shapes the guard actually judges, where v1 returns NaN.
  assert.ok(Number.isNaN(addMonths(NaN, 1, 0).y) && Number.isNaN(v1dates.addMonths(NaN, 1, 0).y));
  assert.ok(Number.isNaN(dow(NaN, 11, 22)) && Number.isNaN(v1dates.dow(NaN, 11, 22)));
});

test('ATT-97 — a pinned board with no startMonth is REFUSED, never projected', () => {
  // THE HANG. `DEFAULT_SETTINGS.startMonth` is null (core/ may not read a clock), so a caller
  // who omits `ctx.defaultSettings` used to get `settings.startMonth: null`. `layout.js:25` then
  // does `parseISO('null-01')` → `{y: NaN, m: NaN}`, and `holidays.js:51`'s
  // `while (dow(year, 11, d) !== 3) d -= 1;` never terminates. The app hangs, hard.
  //
  // Against the OLD code every assertion below fails: materialize returned a settings object
  // with `startMonth: null` instead of throwing.
  const pinned = foldOps([op(GENESIS(0), ME, PREF_ENTITY, flattenPref({ mode: 'pinned' }))]);
  assert.throws(() => materialize(pinned, {}), MaterializeError);
  assert.throws(() => materialize(pinned, {}), /ctx\.defaultSettings/);
  assert.throws(() => materialize(pinned, { defaultSettings: DEFAULT_SETTINGS }), MaterializeError,
    'DEFAULT_SETTINGS is the headless fallback and is NOT a usable ctx.defaultSettings');

  // REG-9 — THE GUARD IS THE HANG CONDITION, NOT A FORMAT RULE.
  //
  // This list used to read ['2026-13', '2026', 'null', '2026-1', '', 0] and every one of them was
  // refused, because the guard was `/^\d{4}-(0[1-9]|1[0-2])$/`. Four of those six are boards v1
  // opens with twelve correct columns (see the v1-oracle half of REG-9 in
  // tests/attack/regression-v1-fidelity.test.js), so the guard was turning openable boards into
  // an unopenable app. What is refused now is exactly what makes `holidays.js:51` spin.
  for (const bad of ['null', 'undefined', 'abc', 'nope-01', '20x6-01', '999999-01', null, true]) {
    assert.throws(
      () => materialize(foldOps([op(GENESIS(0), ME, PREF_ENTITY, flattenPref({ mode: 'pinned', startMonth: bad }))]), {}),
      MaterializeError, `startMonth ${JSON.stringify(bad)} was projected and hangs holidays.js`);
  }

  // …and these PROJECT, because v1 renders every one of them. `visibleStart` is v1's own, so the
  // month each of them lands on is asserted against the real implementation, not a copy.
  for (const [good, first] of [['2026-1', '2026-1'], ['2026-13', '2027-1'], ['2026-00', '2025-12'],
    ['26-01', '26-1'], ['2026-01', '2026-1'], ['2026', '2026-1'], ['', '0-1'], [0, '0-1']]) {
    const st = materialize(
      foldOps([op(GENESIS(0), ME, PREF_ENTITY, flattenPref({ mode: 'pinned', startMonth: good }))]), {});
    assert.equal(st.settings.startMonth, good, `startMonth ${JSON.stringify(good)} was rewritten`);
    const v = visibleStart(st.settings, '2026-03-04');
    assert.equal(`${v.y}-${v.m}`, first, `visibleStart(${JSON.stringify(good)})`);
    assert.ok(Number.isInteger(v.y) && Number.isInteger(v.m));
  }

  // `pageYears` is part of the question: `visibleStart` adds `pageYears * 12` months, so a huge
  // page offset hangs the same loop from a perfectly well-formed startMonth. The regex could not
  // see this field at all.
  assert.throws(
    () => materialize(foldOps([op(GENESIS(0), ME, PREF_ENTITY,
      flattenPref({ mode: 'pinned', startMonth: '2026-01', pageYears: 1e9 }))]), {}),
    MaterializeError, 'a 1e9 page offset walks holidays.js off the end of Date');
  assert.equal(materialize(foldOps([op(GENESIS(0), ME, PREF_ENTITY,
    flattenPref({ mode: 'pinned', startMonth: '2026-01', pageYears: 3 }))]), {}).settings.pageYears, 3);

  // The predicate itself, directly: it is a property of the YEAR, and the boundary is the range
  // `Date` can express — no threshold to tune and nothing about string format in it.
  assert.equal(yearIsRenderable(2026), true);
  assert.equal(yearIsRenderable(26), true);
  assert.equal(yearIsRenderable(0), true);
  assert.equal(yearIsRenderable(NaN), false);
  assert.equal(yearIsRenderable(1e9), false);
  assert.equal(pinnedMonthsRenderable('2026-1', 0), true);
  assert.equal(pinnedMonthsRenderable(null, 0), false);
  assert.equal(pinnedMonthsRenderable(Symbol('x'), 0), false, 'a predicate must refuse, not throw');

  // A real caller passes v1's own defaults and everything works.
  assert.equal(materialize(pinned, soloCtx()).settings.startMonth, V1_DEFAULT_SETTINGS.startMonth);
  assert.equal(materialize(foldOps([
    op(GENESIS(0), ME, PREF_ENTITY, flattenPref({ mode: 'pinned', startMonth: '2026-01' })),
  ]), {}).settings.startMonth, '2026-01', 'a pref that supplies it needs no ctx at all');

  // ROLLING is untouched — `layout.js:24` never reads `startMonth` there, so a headless fold
  // with a bare ctx keeps working. That is what bounds the blast radius of the throw.
  assert.equal(materialize(foldOps([op(GENESIS(0), ME, PREF_ENTITY, { rowHeight: 30 })]), {}).settings.startMonth, null);

  // …and the whole point, end to end: nothing materialize returns can reach visibleStart's NaN.
  for (const ctx of [soloCtx(), {}]) {
    let st;
    try { st = materialize(pinned, ctx); } catch (e) {
      assert.ok(e instanceof MaterializeError); continue;
    }
    const start = visibleStart(st.settings, '2026-03-04');
    assert.ok(Number.isInteger(start.y) && Number.isInteger(start.m), 'visibleStart returned NaN');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// H. DERIVED TIMESTAMPS (ADR 001 §1.4)
// ═════════════════════════════════════════════════════════════════════════════

test('createdAt is the _born stamp, updatedAt the max, updatedBy its author', () => {
  const born = GENESIS(4);
  const last = fmt(500, 0, DEV_B);
  const regs = foldOps([
    op(born, ME, 'note:t', { _born: born, date: '2026-05-01', text: 'a', _alive: true }),
    op(fmt(100, 0, DEV_A), ME, 'note:t', { text: 'b' }),
    op(last, MAMA, 'note:t', { date: '2026-06-01' }),
  ]);
  assert.equal(createdAt(regs, 'note:t'), born);
  assert.equal(updatedAt(regs, 'note:t'), last);
  assert.equal(updatedBy(regs, 'note:t'), MAMA);
  const n = materialize(regs, soloCtx()).notes[0];
  assert.equal(n.createdAt, born);
  assert.equal(n.updatedAt, last);
  assert.equal(n.updatedBy, MAMA);
});

test('the three derivations are null for an entity with no registers', () => {
  const regs = new Map();
  assert.equal(createdAt(regs, 'note:nope'), null);
  assert.equal(updatedAt(regs, 'note:nope'), null);
  assert.equal(updatedBy(regs, 'note:nope'), null);
});

test('17.6 — a promoted co-editor write drives updatedAt/updatedBy on my own entry', () => {
  const { regs, fk } = coEditedNote();
  const t = fmt(900, 0, DEV_B);
  foldOps([op(t, MAMA, fk, { 'pub.text': 'Zahnarzt 15:30' })], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.updatedAt, t);
  assert.equal(n.updatedBy, MAMA, '"geändert" must name the co-editor whose value is displayed');
});

test('a pub register that LOST promotion does not claim the "geändert" line', () => {
  // Attributing a change to a register whose value was not used is a lie about what changed.
  const { regs, fk } = coEditedNote();
  const mine = fmt(900, 0, DEV_A);
  foldOps([
    op(mine, ME, 'note:ce', { text: 'mine, later' }),
    op(fmt(800, 0, DEV_B), MAMA, fk, { 'pub.text': 'hers, earlier' }),
  ], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.text, 'mine, later');
  assert.equal(n.updatedAt, mine);
  assert.equal(n.updatedBy, ME);
});

test('a foreign entry\'s times come from its family registers', () => {
  const k = familyKey('fnote', MAMA, 'ts');
  const born = GENESIS(9);
  const last = fmt(700, 0, DEV_B);
  const regs = foldOps([
    op(born, MAMA, k, { _born: born, 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'x' }),
    op(last, MAMA, k, { 'pub.text': 'y' }),
  ]);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.createdAt, born);
  assert.equal(n.updatedAt, last);
  assert.equal(n.updatedBy, MAMA);
});

// ═════════════════════════════════════════════════════════════════════════════
// I. EXPOSURE BADGE (16.6) AND THE „neu" DOT (17.5)
// ═════════════════════════════════════════════════════════════════════════════

test('exposure reports the current published level when nothing is pending', () => {
  const { regs } = coEditedNote();
  assert.deepEqual(materialize(regs, familyCtx()).notes[0].exposure, { level: 'geteilt', pending: false });
});

test('an unpublished entry reads as privat, and solo entries have no exposure at all', () => {
  const regs = foldOps([op(GENESIS(0), ME, 'note:solo', { _born: GENESIS(0), date: '2026-05-01', text: 'x', _alive: true })]);
  assert.deepEqual(materialize(regs, familyCtx()).notes[0].exposure, { level: 'privat', pending: false });
  assert.equal(materialize(regs, soloCtx()).notes[0].exposure, null);
});

test('a pending UPGRADE shows the old, LOWER exposure — the badge never under-reports', () => {
  const { regs, fk } = coEditedNote();   // current level: geteilt
  const ctx = familyCtx({ lastAckedPubLevel: (e) => (e === fk ? 'belegt' : null) });
  assert.deepEqual(materialize(regs, ctx).notes[0].exposure, { level: 'belegt', pending: true });
});

test('a pending DOWNGRADE shows the old, HIGHER exposure', () => {
  const { regs, fk } = coEditedNote();
  foldOps([op(fmt(300, 0, DEV_A), ME, fk, { 'pub.level': 'belegt', 'pub.text': null })], regs);
  const ctx = familyCtx({ lastAckedPubLevel: (e) => (e === fk ? 'geteilt' : null) });
  assert.deepEqual(materialize(regs, ctx).notes[0].exposure, { level: 'geteilt', pending: true });
});

test('an explicit pendingPub hook overrides the derived flag', () => {
  const { regs, fk } = coEditedNote();
  const ctx = familyCtx({ lastAckedPubLevel: () => 'geteilt', pendingPub: (e) => e === fk });
  assert.deepEqual(materialize(regs, ctx).notes[0].exposure, { level: 'geteilt', pending: true });
});

test('a foreign entry never carries an exposure badge — it is MY disclosure state, not theirs', () => {
  const regs = foldOps([op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'e'), {
    _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'x',
  })]);
  assert.equal(materialize(regs, familyCtx()).notes[0].exposure, null);
});

test('isNew is off by default, and off for my own entries always', () => {
  const regs = foldOps(chaosOps());
  const out = materialize(regs, familyCtx());
  for (const e of [...out.notes, ...out.bars]) assert.equal(e.isNew, false);
});

test('isNew fires when the entity\'s max seq is past lastSeenSeq[space]', () => {
  const k = familyKey('fnote', MAMA, 'nw');
  const regs = foldOps([op(GENESIS(0), MAMA, k, {
    _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'x',
  })]);
  const ctx = (seq, seen) => familyCtx({
    seqOf: () => seq, lastSeenSeq: { fsp_0000000000000000000000: seen },
  });
  assert.equal(materialize(regs, ctx('412', '400')).notes[0].isNew, true);
  assert.equal(materialize(regs, ctx('400', '400')).notes[0].isNew, false);
  assert.equal(materialize(regs, ctx('399', '400')).notes[0].isNew, false);
  // decimal, not lexicographic — "9" must not beat "400"
  assert.equal(materialize(regs, ctx('9', '400')).notes[0].isNew, false);
  assert.equal(materialize(regs, ctx('1000', '999')).notes[0].isNew, true);
});

test('17.5 — a downgrade never dots and a deletion never dots, whatever the seq says', () => {
  // ADR 004 §7 forbids surveillance mechanics. The suppression is enforced in materialize, so a
  // caller with a sloppy seq source still cannot make a retraction blink.
  const k = familyKey('fnote', MAMA, 'sup');
  const regs = foldOps([op(GENESIS(0), MAMA, k, {
    _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'x',
  })]);
  const loud = { seqOf: () => '9999', lastSeenSeq: { fsp_0000000000000000000000: '1' } };
  assert.equal(materialize(regs, familyCtx(loud)).notes[0].isNew, true);
  assert.equal(materialize(regs, familyCtx({ ...loud, levelDecreased: () => true })).notes[0].isNew, false);

  // and once it is deleted there is no entry at all — the dot has nothing to sit on
  foldOps([op(fmt(2, 0, DEV_B), MAMA, k, { 'pub.alive': false })], regs);
  assert.deepEqual(materialize(regs, familyCtx(loud)).notes, []);
});

test('an explicit isNew hook is honoured but is still subject to the suppression rules', () => {
  const k = familyKey('fnote', MAMA, 'h');
  const regs = foldOps([op(GENESIS(0), MAMA, k, {
    _born: GENESIS(0), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'x',
  })]);
  assert.equal(materialize(regs, familyCtx({ isNew: () => true })).notes[0].isNew, true);
  assert.equal(
    materialize(regs, familyCtx({ isNew: () => true, levelDecreased: () => true })).notes[0].isNew,
    false,
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// J. DECORATION — the fields layout.js and board.js branch on
// ═════════════════════════════════════════════════════════════════════════════

test('every entry carries isForeign, ownerId and the colour source layout.js:142 needs', () => {
  // layout.js:142/:196 do `isForeign ? colorOf(memberColorRef) : colorOf(catOf.get(categoryId))`.
  // A foreign entry with a null memberColorRef would fall through to colorOf(undefined), which
  // silently returns PALETTE[0] — blue — and would render another member's entry as one of mine.
  const regs = foldOps([
    op(GENESIS(0), ME, 'note:mine', { _born: GENESIS(0), date: '2026-05-01', text: 'm', categoryId: CAT[0], _alive: true }),
    op(GENESIS(1), MAMA, familyKey('fnote', MAMA, 'hers'), {
      _born: GENESIS(1), 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.text': 'h',
    }),
  ]);
  const out = materialize(regs, familyCtx());
  const mine = out.notes.find((n) => !n.isForeign);
  const hers = out.notes.find((n) => n.isForeign);
  assert.equal(mine.ownerId, ME);
  assert.equal(mine.memberColorRef, null);
  assert.equal(mine.initial, null);
  assert.equal(mine.categoryId, CAT[0]);
  assert.equal(hers.ownerId, MAMA);
  assert.equal(hers.memberColorRef, 'magenta');
  assert.equal(hers.initial, 'M');
});

test('an unknown member yields null decorations rather than a fabricated colour', () => {
  const regs = foldOps([op(GENESIS(0), MAMA, familyKey('fnote', MAMA, 'x'), {
    _born: GENESIS(0), 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-05-01',
  })]);
  const ctx = familyCtx({ members: new Map(), currentMembers: new Set([MAMA]) });
  const n = materialize(regs, ctx).notes[0];
  assert.equal(n.memberColorRef, null);
  assert.equal(n.initial, null);
});

test('a downgraded Belegt block is indistinguishable from one that was always Belegt (ADR 004 §7.1)', () => {
  // No history, no „war geteilt", nothing in the object one could derive it from — apart from the
  // timestamps §1.4 requires, which say WHEN and never WHAT.
  const always = familyKey('fnote', MAMA, 'always');
  const was = familyKey('fnote', MAMA, 'was');
  const t0 = GENESIS(0);
  const t1 = fmt(10, 0, DEV_B);
  const regs = foldOps([
    op(t0, MAMA, always, { _born: t0, 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.repeatsYearly': false }),
    op(t0, MAMA, was, { _born: t0, 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-05-01', 'pub.repeatsYearly': false, 'pub.text': 'was shared', 'pub.coEdit': true }),
    op(t1, MAMA, always, { 'pub.date': '2026-05-01' }),
    op(t1, MAMA, was, { 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null }),
  ]);
  const out = materialize(regs, familyCtx());
  const a = out.notes.find((n) => n.uuid === 'always');
  const w = out.notes.find((n) => n.uuid === 'was');
  const shape = (n) => Object.keys(n).sort();
  assert.deepEqual(shape(w), shape(a), 'the downgraded block has a different field set');
  assert.equal(w.redacted, true);
  assert.equal(w.level, 'belegt');
  assert.equal('text' in w, false, 'the withdrawn text is still on the entry');
});

test('level and visibility are separate: an admin unshare may leave them disagreeing for one round trip', () => {
  const { regs, fk } = coEditedNote();
  foldOps([op(fmt(50, 0, DEV_B), ADMIN, fk, {
    'pub.level': 'privat', 'pub.alive': false, 'pub.text': null, 'pub.date': null,
    'pub.repeatsYearly': null, 'pub.coEdit': null,
  })], regs);
  const n = materialize(regs, familyCtx()).notes[0];
  assert.equal(n.visibility, 'geteilt', 'materialization must not silently rewrite the truth');
  assert.equal(n.level, 'privat');
});

// ═════════════════════════════════════════════════════════════════════════════
// K. PARKED OPS — not applied, not lost
// ═════════════════════════════════════════════════════════════════════════════

test('a parked op contributes nothing until it is unparked, and then contributes fully', () => {
  // Parking is what makes an old client degrade to "does not show the new thing" instead of
  // "loses the new thing" (ADR 001 §7.4). materialize sees only the folded registers, so the
  // property is: the parked op's effect is absent, the op itself survives, and unparking is a
  // plain fold with no special case.
  const base = [op(GENESIS(0), ME, 'note:p', { _born: GENESIS(0), date: '2026-05-01', text: 'now', categoryId: CAT[0], _alive: true })];
  // Parked for a stamp more than 24 h in the future (a peer with a broken clock).
  const future = op(fmt(9_999_999_999_999, 0, DEV_B), MAMA, 'note:p', { text: 'from a broken clock' });
  // Parked for a field name this build does not know (a newer sibling in the family).
  const unknownField = op(GENESIS(1), MAMA, 'note:p', { someFutureField: 'v3 feature' });

  const regs = foldOps(base);
  assert.equal(materialize(regs, soloCtx()).notes[0].text, 'now');

  // An unknown field must never reach the join at all — it is parked upstream, and the join
  // refuses it loudly rather than minting a register nothing downstream can read.
  assert.throws(() => applyOp(regs, unknownField), /someFutureField/);
  assert.equal('someFutureField' in materialize(regs, soloCtx()).notes[0], false);

  // The parked ops are RETAINED. When the local clock advances past the future stamp, unparking
  // is a plain fold with no special case, and the op wins or loses by the identical rule.
  foldOps([future], regs);
  assert.equal(materialize(regs, soloCtx()).notes[0].text, 'from a broken clock');
});

// ═════════════════════════════════════════════════════════════════════════════
// L. SCALE — the sort and the fold hold up on a family-sized board
// ═════════════════════════════════════════════════════════════════════════════

test('a family-sized board (8 members, ~2 400 entries) materializes deterministically', () => {
  const ops = [];
  for (let i = 0; i < 4; i++) {
    ops.push(op(GENESIS(i), ME, `cat:${CAT[i]}`, {
      name: `C${i}`, nameEn: `C${i}`, paletteRef: 'blau', visible: true,
      defaultVisibility: 'privat', _alive: true, _born: GENESIS(i),
    }));
  }
  const members = [ME, MAMA, ADMIN, ...Array.from({ length: 5 }, (_, i) => `mem_${'z'.repeat(21)}${i}`)];
  let idx = 100;
  for (const [mi, m] of members.entries()) {
    for (let j = 0; j < 300; j++) {
      const born = GENESIS(idx++);
      const day = `2026-${String((j % 12) + 1).padStart(2, '0')}-${String((j % 28) + 1).padStart(2, '0')}`;
      if (m === ME) {
        ops.push(op(born, ME, `note:me${j}`, {
          _born: born, date: day, text: `t${j}`, categoryId: CAT[j % 4],
          repeatsYearly: false, visibility: 'privat', coEdit: false, _alive: true,
        }));
      } else {
        ops.push(op(born, m, familyKey('fnote', m, `u${mi}_${j}`), {
          _born: born, 'pub.level': j % 3 === 0 ? 'belegt' : 'geteilt', 'pub.alive': true,
          'pub.date': day, 'pub.repeatsYearly': false,
          ...(j % 3 === 0 ? {} : { 'pub.text': `m${mi}-${j}` }),
        }));
      }
    }
  }
  const ctx = familyCtx({
    members: new Map(members.map((m, i) => [m, { displayName: `M${i}`, colorRef: 'blau', initial: 'M' }])),
    currentMembers: new Set(members),
  });
  const ref = J(materialize(foldOps(ops), ctx));
  assert.equal(materialize(foldOps(ops), ctx).notes.length, 2400);
  for (const seed of [11, 12, 13]) {
    assert.equal(J(materialize(foldOps(shuffled(ops, mulberry32(seed))), ctx)), ref, `seed ${seed} diverged`);
  }
});
