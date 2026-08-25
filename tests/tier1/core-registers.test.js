// tests/tier1/core-registers.test.js — the LWW join. ADR 001 §1.4, §2, §5, §6, §7.2 · ADR 004
// §1, §4.1, §5.1 · ops.contract.js §3.
//
// WHAT THIS FILE IS PROTECTING, in the order it matters.
//
//  1. ACI, ASSERTED DIRECTLY BEFORE IT IS ASSERTED STATISTICALLY. ADR 001 §6 derives convergence
//     out of one premise: max over a total order is associative, commutative and idempotent.
//     Section C below checks those three laws on small HAND-WRITTEN op sets where a failure names
//     the exact pair that broke, and only then does section D throw 200 seeded shuffles,
//     duplicates, partitions and interleavings at it. A property test that fails on shuffle #137
//     of a 60-op stream tells you almost nothing; `fold(a,b) === fold(b,a)` on four ops tells you
//     everything. (NB: never write the word f-r-o-m before a quoted string in a tier-1 test file —
//     suite-integrity.test.js greps for that shape to police imports, and a prose sentence trips
//     it. This paragraph was rewritten for exactly that reason; please do not "tidy" it back.)
//
//  2. R9 — `null` IS A VALUE, ABSENCE IS NOT. Section E scripts the exact defect ADR 004 §5.1
//     calls "the single highest-value defect in the whole v2 surface": a Geteilt→Belegt downgrade
//     that OMITS `pub.text` instead of nulling it leaves the text rendered on every peer while
//     the owner's own board looks correctly downgraded. No owner-side smoke test catches it. Both
//     the broken patch and the correct one are folded here and the difference is asserted.
//
//  3. THE PROMOTION ASYMMETRY (ADR 004 §4.1, property P7c). Section G runs the exact scenario the
//     rule exists for — I downgrade my own Geteilt note to Belegt, publishing `pub.text: null` —
//     and asserts my own text survives, on the authoring Mac AND on my second Mac. Then it runs
//     the mirror case (a co-editor's write DOES win) so the test cannot pass by promoting
//     nothing.
//
//  4. THE TWO NAMESPACES CANNOT TOUCH. Section F asserts that no truth field can be written into
//     a family entity and no `pub.*` field into a truth entity — including `pub.categoryId`,
//     whose non-existence IS A3 (ADR 004 §1).
//
// ADVERSARIAL BY DEFAULT. This module is part of a sync system, so "reordered", "duplicated",
// "interleaved" and "partitioned" are the normal case, not the edge case. Every convergence
// assertion here is made over a stream that has been through all four.
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every stamp is a literal or comes from a fake HLC
// bound to a fake `now`; every id comes from a counter; every shuffle comes from a seeded
// mulberry32 whose seed is in the assertion message.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RegisterError, REGISTER_FORMAT,
  emptyRegisters, applyOp, foldAll, fold, mergeMaps, cloneRegisters,
  applicabilityError, cmpWrites, maxWrite,
  getRegister, getValue, hasRegister, registersOf, entityKeys, fieldNames, registerCount,
  createdAt, updatedAt, updatedBy,
  pubFieldFor, truthFieldFor, promoteRegister, promoteEntity, withdrawnByOther,
  serializeRegisters, deserializeRegisters,
} from '../../src/js/core/registers.js';

import { createClock, fmt, cmp } from '../../src/js/core/stamp.js';
import { FIELDS, coEditableFields, governingFields, makeOp, OP_VERSION } from '../../src/js/core/ops.js';
import { familyKey, FAMILY_OF, TRUTH_OF, VISIBILITY_LEVELS } from '../../src/js/core/entities.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic scaffolding. Seeded, injected, wall-clock-free.
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ME = `mem_${'A'.repeat(22)}`;
const MAMA = `mem_${'M'.repeat(22)}`;
const PAPA = `mem_${'P'.repeat(22)}`;
const PSP = `psp_${'E'.repeat(22)}`;
const FSP = `fsp_${'F'.repeat(22)}`;
const GID = 'C'.repeat(22);

const SHORT = {
  laptop: '7QAR2MZ9XKPNC0GV',
  desktop: 'ZZZZZZZZZZZZZZZZ',
  mama: 'HHHHHHHHHHHHHHHH',
  papa: '1111111111111111',
};

const NOTE = 'note:5e1a-4b2c-9c';
const NOTE2 = 'note:aaaa-bbbb-cc';
const BAR = 'bar:7f3d-2e1a-0b';
const CAT = 'cat:c0c0-1111-22';
const FNOTE = familyKey('fnote', ME, '5e1a-4b2c-9c');
const FNOTE_MAMA = familyKey('fnote', MAMA, 'dddd-eeee-ff');

const stampAt = (ms, ctr = 0, dev = SHORT.laptop) => fmt(ms, ctr, dev);

/** A raw op, built by hand so a test can make exactly one thing wrong about it. */
let rawSeq = 0;
function op(over = {}) {
  return {
    v: OP_VERSION,
    id: String(++rawSeq).padStart(22, 'q'),
    ts: stampAt(1787836800000, 0),
    space: PSP,
    act: ME,
    dev: `dev_${'B'.repeat(22)}`,
    gid: GID,
    k: 'note.set',
    e: NOTE,
    f: { text: 'Zahnarzt' },
    ...over,
  };
}

/**
 * A device: its own HLC on its own fake wall clock, its own op ids. Nothing here reads a real
 * clock or a real CSPRNG. `emit` builds through the REAL `makeOp`, so every op in this file has
 * already been through `validateOp`.
 */
function device(name, { member = ME, short = SHORT.laptop, startMs = 1787836800000 } = {}) {
  let nowMs = startMs;
  let n = 0;
  const clock = createClock(short, () => nowMs);
  const ctx = {
    act: member,
    dev: `dev_${name[0].toUpperCase().repeat(22)}`,
    gid: GID,
    space: PSP,
    familySpaceId: FSP,
    mint: () => clock.tick(),
    newOpId: () => `${name.slice(0, 2)}${String(++n).padStart(20, '0')}`,
  };
  return {
    name,
    ctx,
    clock,
    advance(ms) { nowMs += ms; return this; },
    setClock(ms) { nowMs = ms; return this; },
    observe(stamp) { clock.observe(stamp); return this; },
    /** @returns {Object} one frozen, validated op */
    emit(kind, entity, f, opts) {
      return makeOp({ ...ctx, gid: opts?.gid ?? GID }, kind, entity, f, opts);
    },
    note(f, o) { return this.emit('note.set', NOTE, f, o); },
    pub(f, o) { return this.emit('pub.set', FNOTE, f, o); },
  };
}

/** Canonical, order-independent identity of a whole register map. */
const sig = (regs) => JSON.stringify(serializeRegisters(regs));

const foldOf = (...lists) => fold(...lists);

// ═════════════════════════════════════════════════════════════════════════════
// A. `≺` — the order on writes (ADR 001 §6 step 1)
// ═════════════════════════════════════════════════════════════════════════════

test('cmpWrites orders by stamp first, and agrees with a plain stamp sort', () => {
  const a = { stamp: stampAt(1000), op: 'z'.repeat(22), value: 'z' };
  const b = { stamp: stampAt(2000), op: 'a'.repeat(22), value: 'a' };
  assert.equal(cmpWrites(a, b), -1);
  assert.equal(cmpWrites(b, a), 1);
  assert.equal(cmp(a.stamp, b.stamp), -1);
});

test('the deviceShort is the tiebreak inside one millisecond and one counter', () => {
  // ADR 001 §1.3: "deviceShort is the final tiebreak and it is total". '1'*16 < '7QAR…' < 'Z'*16
  // in the Crockford alphabet, and the fixed width is what makes plain `<` mean that.
  const papa = { stamp: stampAt(5000, 7, SHORT.papa), op: 'a'.repeat(22), value: 1 };
  const mine = { stamp: stampAt(5000, 7, SHORT.laptop), op: 'a'.repeat(22), value: 2 };
  const desk = { stamp: stampAt(5000, 7, SHORT.desktop), op: 'a'.repeat(22), value: 3 };
  assert.equal(cmpWrites(papa, mine), -1);
  assert.equal(cmpWrites(mine, desk), -1);
  assert.equal(cmpWrites(papa, desk), -1);
});

test('the counter outranks the deviceShort and is outranked by the wall millis', () => {
  const lo = { stamp: stampAt(5000, 1, SHORT.desktop), op: 'a'.repeat(22), value: 1 };
  const hi = { stamp: stampAt(5000, 2, SHORT.papa), op: 'a'.repeat(22), value: 2 };
  assert.equal(cmpWrites(lo, hi), -1);
  const later = { stamp: stampAt(5001, 0, SHORT.papa), op: 'a'.repeat(22), value: 3 };
  assert.equal(cmpWrites(hi, later), -1);
});

test('the opId breaks a stamp tie, and the value breaks an opId tie', () => {
  // ADR 001 §6 calls the opId "unreachable" for honest devices, and it is: two distinct honest
  // writes always differ in (ms, ctr, deviceShort). A device running a modified client can still
  // emit two ops at one stamp, and if `≺` returned 0 there, two peers receiving that pair in
  // different orders would DIVERGE. That is the failure this module exists to make impossible.
  const s = stampAt(9000, 3);
  const a = { stamp: s, op: 'a'.repeat(22), value: 'left' };
  const b = { stamp: s, op: 'b'.repeat(22), value: 'right' };
  assert.equal(cmpWrites(a, b), -1);
  const c = { stamp: s, op: 'a'.repeat(22), value: 'zzz' };
  assert.equal(cmpWrites(a, c), -1);
  assert.equal(cmpWrites(c, a), 1);
});

test('cmpWrites returns 0 only for genuinely identical writes', () => {
  const w = { stamp: stampAt(1), op: 'q'.repeat(22), value: null };
  assert.equal(cmpWrites(w, { ...w }), 0);
  // `null` ranks ABOVE every non-null value, and that rank is load-bearing rather than arbitrary:
  // the ADR 004 §5.3 forget pass blanks a register IN PLACE at its existing stamp AND opId, so
  // re-delivering the very op that wrote it is an exact double tie against its own blanked self.
  // If `null` lost that tie, a cold re-delivery of a publication would UN-BLANK a field the owner
  // retracted. Flipped from -1 during WP-1 integration; see registers.js:valueKey and the
  // formerly-KNOWN-GAP test in core-oplog.test.js.
  assert.equal(cmpWrites(w, { ...w, value: false }), 1);
  assert.equal(cmpWrites({ ...w, value: false }, w), -1);
});

test('`≺` is antisymmetric and transitive over a shuffled pool of writes', () => {
  const rnd = mulberry32(4242);
  const pool = [];
  for (let i = 0; i < 40; i++) {
    pool.push({
      stamp: stampAt(1000 + (i % 5), i % 3, [SHORT.laptop, SHORT.mama, SHORT.papa][i % 3]),
      op: String(i % 7).padStart(22, 'k'),
      value: [null, true, false, 0, 1, 'a', 'b'][i % 7],
    });
  }
  for (const a of pool) {
    for (const b of pool) {
      // `+` rather than `-`: a 0 result negates to -0 and strict equality separates them.
      assert.equal(cmpWrites(a, b) + cmpWrites(b, a), 0, 'antisymmetry');
    }
  }
  const sorted = shuffle(rnd, pool).sort(cmpWrites);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(cmpWrites(sorted[i - 1], sorted[i]) <= 0, 'sort agrees with the comparator');
  }
  // transitivity over every ordered triple of a sample
  const s = sorted.slice(0, 12);
  for (let i = 0; i < s.length; i++) {
    for (let j = i; j < s.length; j++) {
      for (let k = j; k < s.length; k++) {
        assert.ok(cmpWrites(s[i], s[k]) <= 0, `transitivity ${i}/${j}/${k}`);
      }
    }
  }
});

test('maxWrite is the join on one cell, undefined-tolerant on both sides', () => {
  const lo = { stamp: stampAt(1), op: 'a'.repeat(22), value: 'lo' };
  const hi = { stamp: stampAt(2), op: 'a'.repeat(22), value: 'hi' };
  assert.equal(maxWrite(lo, hi), hi);
  assert.equal(maxWrite(hi, lo), hi);
  assert.equal(maxWrite(undefined, lo), lo);
  assert.equal(maxWrite(lo, undefined), lo);
  assert.equal(maxWrite(undefined, undefined), undefined);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. applyOp — one op into the map
// ═════════════════════════════════════════════════════════════════════════════

test('applyOp creates one register per field, carrying value, stamp, author and opId', () => {
  const regs = emptyRegisters();
  const o = op({ ts: stampAt(1000, 4), act: MAMA, f: { text: 'Zahnarzt', date: '2026-09-10' } });
  assert.equal(applyOp(regs, o), true);
  assert.deepEqual(getRegister(regs, NOTE, 'text'), {
    value: 'Zahnarzt', stamp: stampAt(1000, 4), author: MAMA, op: o.id,
  });
  assert.equal(getValue(regs, NOTE, 'date'), '2026-09-10');
  assert.equal(registerCount(regs), 2);
});

test('the author is the acting MEMBER, never the device', () => {
  // ADR 001 §1.4 reads it for `updatedBy` ("von Mama", 17.6) and ADR 004 §4.1 compares it against
  // `me`. With the DEVICE here instead, my own second Mac's retraction would be promoted onto my
  // truth and a Belegt downgrade would blank my note on the other machine. See section G.
  const regs = emptyRegisters();
  applyOp(regs, op({ act: MAMA, dev: `dev_${'X'.repeat(22)}` }));
  assert.equal(getRegister(regs, NOTE, 'text').author, MAMA);
  assert.notEqual(getRegister(regs, NOTE, 'text').author, `dev_${'X'.repeat(22)}`);
});

test('a re-delivered op changes nothing and reports no change', () => {
  const regs = emptyRegisters();
  const o = op();
  assert.equal(applyOp(regs, o), true);
  const before = sig(regs);
  assert.equal(applyOp(regs, o), false, 'duplicate delivery must be a no-op');
  assert.equal(applyOp(regs, o), false);
  assert.equal(applyOp(regs, { ...o, f: { ...o.f } }), false, 'a structurally equal copy too');
  assert.equal(sig(regs), before);
});

test('an older op never moves a register — monotone reads (ADR 001 §6)', () => {
  const regs = emptyRegisters();
  applyOp(regs, op({ ts: stampAt(2000), f: { text: 'neu' } }));
  const before = sig(regs);
  assert.equal(applyOp(regs, op({ ts: stampAt(1000), f: { text: 'alt' } })), false);
  assert.equal(getValue(regs, NOTE, 'text'), 'neu');
  assert.equal(sig(regs), before, 'a three-weeks-late op is silently absorbed, never applied');
});

test('a newer op carrying the SAME value still reports a change', () => {
  // The register changed even though the rendered value did not: `updatedAt`, `updatedBy` and
  // 17.6's "geändert So." all move with it. Over-reporting is safe here; under-reporting drops a
  // re-render. Documented on applyOp so nobody "optimizes" it into a value diff.
  const regs = emptyRegisters();
  applyOp(regs, op({ ts: stampAt(1000), act: ME, f: { text: 'Zahnarzt' } }));
  assert.equal(applyOp(regs, op({ ts: stampAt(2000), act: MAMA, f: { text: 'Zahnarzt' } })), true);
  assert.equal(getRegister(regs, NOTE, 'text').author, MAMA);
});

test('applyOp reports a change when ANY field of a multi-field patch wins', () => {
  const regs = emptyRegisters();
  applyOp(regs, op({ ts: stampAt(3000), f: { text: 'a', date: '2026-01-01' } }));
  // older text (loses), newer date (wins) — one op, one stamp, so this cannot actually happen
  // through makeOp; it is the mixed case mergeMaps hits, asserted here at the op level too.
  const mixed = op({ ts: stampAt(3000, 1), f: { text: 'b', date: '2026-02-02' } });
  assert.equal(applyOp(regs, mixed), true);
  assert.equal(getValue(regs, NOTE, 'text'), 'b');
  assert.equal(getValue(regs, NOTE, 'date'), '2026-02-02');
});

test('applyOp never mutates the op it was handed', () => {
  const regs = emptyRegisters();
  const o = op({ f: { text: 'Zahnarzt' } });
  const snapshot = JSON.stringify(o);
  applyOp(regs, o);
  applyOp(regs, o);
  assert.equal(JSON.stringify(o), snapshot);
});

test('registers are frozen — nothing downstream can edit the merge result in place', () => {
  const regs = emptyRegisters();
  applyOp(regs, op());
  const r = getRegister(regs, NOTE, 'text');
  assert.ok(Object.isFrozen(r));
  assert.throws(() => { 'use strict'; r.value = 'hacked'; }, TypeError);
});

test('applyOp refuses a malformed op, loudly, rather than poisoning the map', () => {
  const regs = emptyRegisters();
  const cases = [
    [null, 'not an object'],
    [op({ ts: 'nope' }), 'stamp'],
    [op({ ts: '1787836800000.000000.lowercasedev!' }), 'stamp'],
    [op({ act: 'mama' }), 'MemberId'],
    [op({ id: 'short' }), 'OpId'],
    [op({ e: 'note:' }), 'entity key'],
    [op({ e: 'frobnicate:xyz' }), 'entity key'],
    [op({ f: {} }), 'empty'],
    [op({ f: null }), 'not an object'],
    [op({ f: { text: ['a'] } }), 'scalar'],
    [op({ f: { text: { a: 1 } } }), 'scalar'],
    [op({ f: { text: undefined } }), 'scalar'],
    [op({ f: { text: NaN } }), 'scalar'],
    [op({ f: { text: Infinity } }), 'scalar'],
    [op({ f: { nosuchfield: 1 } }), 'no field'],
    // a COMPUTED key: `{ __proto__: 1 }` sets the prototype instead of creating an own property,
    // which is exactly why the guard has to name the three keys explicitly.
    [op({ f: { ['__proto__']: 1 } }), 'forbidden'],
  ];
  for (const [bad, needle] of cases) {
    assert.throws(() => applyOp(regs, bad), (e) => e instanceof RegisterError && e.message.includes(needle),
      `expected a RegisterError mentioning "${needle}"`);
  }
  assert.equal(regs.size, 0, 'not one malformed op left a trace');
});

test('an unknown field name is a caller bug at the join — it is PARKED upstream, never applied', () => {
  // ADR 001 §7.4 / §10: an op carrying a field this build does not know is retained and
  // re-evaluated after an app update. Applying the half we understand is precisely how "does not
  // show the new thing" becomes "loses the new thing", so the join refuses the whole op.
  assert.match(applicabilityError(op({ f: { text: 'ok', futureField: 1 } })), /PARKED/);
  assert.equal(applicabilityError(op({ f: { text: 'ok' } })), null);
});

test('applicabilityError accepts every wildcard register the FIELDS table declares', () => {
  assert.equal(applicabilityError(op({
    k: 'pref.set', e: 'pref:app', space: 'local', gid: null,
    f: { 'layers.feiertage': true, 'lastSeenSeq.fsp_x': '7', density: 3 },
  })), null, 'pref is free-form (ADR 001 §3.3)');
  assert.equal(applicabilityError(op({
    k: 'member.set', e: `member:${MAMA}`, space: FSP,
    f: { [`dev.${SHORT.mama}`]: 'attestation-blob' },
  })), null, 'member.dev.<deviceShort16>');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. ACI, on hand-written op sets. The laws, before the statistics.
// ═════════════════════════════════════════════════════════════════════════════

/** Three small op sets that overlap on fields, entities and stamps. */
function aciSets() {
  const laptop = device('laptop', { short: SHORT.laptop });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 });
  const desktop = device('desktop', { short: SHORT.desktop, startMs: 1787836800000 });

  const a = [
    laptop.note({ text: 'Zahnarzt', date: '2026-09-10', _alive: true }, { born: true }),
    laptop.emit('cat.set', CAT, { name: 'Arzt', visible: true }),
  ];
  desktop.advance(5);
  const b = [
    desktop.note({ date: '2026-09-11' }),                    // same field as a, newer stamp
    desktop.emit('bar.set', BAR, { startDate: '2026-07-01', endDate: '2026-07-14', label: 'Urlaub' }),
  ];
  mama.advance(2);                                            // interleaved between a and b
  const c = [
    mama.emit('pub.set', FNOTE_MAMA, { 'pub.level': 'geteilt', 'pub.text': 'Oma' }),
    mama.emit('cat.set', CAT, { name: 'Ärztin' }),            // concurrent rename of one field
  ];
  return { a, b, c };
}

test('COMMUTATIVE — fold(a,b) equals fold(b,a)', () => {
  const { a, b } = aciSets();
  assert.equal(sig(foldOf(a, b)), sig(foldOf(b, a)));
  assert.deepEqual(foldOf(a, b), foldOf(b, a));
});

test('COMMUTATIVE — every one of the six orderings of three sets agrees', () => {
  const { a, b, c } = aciSets();
  const expected = sig(foldOf(a, b, c));
  for (const [x, y, z] of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
    assert.equal(sig(foldOf(x, y, z)), expected);
  }
});

test('ASSOCIATIVE — fold(fold(a,b),c) equals fold(a,fold(b,c))', () => {
  const { a, b, c } = aciSets();
  const A = foldOf(a), B = foldOf(b), C = foldOf(c);
  const left = mergeMaps(mergeMaps(A, B), C);
  const right = mergeMaps(A, mergeMaps(B, C));
  assert.equal(sig(left), sig(right));
  assert.equal(sig(left), sig(foldOf(a, b, c)));
  // and at the op level: replaying c onto an already-folded (a,b) is the same thing
  assert.equal(sig(foldAll(foldOf(a, b), c)), sig(left));
  assert.equal(sig(foldAll(foldOf(b, c), a)), sig(left));
});

test('IDEMPOTENT — fold(a,a) equals fold(a)', () => {
  const { a } = aciSets();
  assert.equal(sig(foldOf(a, a)), sig(foldOf(a)));
  assert.equal(sig(foldOf(a, a, a, a)), sig(foldOf(a)));
  assert.deepEqual(foldOf(a, a), foldOf(a));
});

test('IDEMPOTENT — folding a set plus any multiset drawn from it changes nothing (P2)', () => {
  const { a, b, c } = aciSets();
  const all = [...a, ...b, ...c];
  const rnd = mulberry32(7);
  const base = sig(foldOf(all));
  for (let trial = 0; trial < 25; trial++) {
    const extra = [];
    for (const o of all) {
      const n = Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) extra.push(o);
    }
    assert.equal(sig(foldOf(shuffle(rnd, [...all, ...extra]))), base, `trial ${trial}`);
  }
});

test('the join is a semilattice cell by cell — the winner is the ≺-max, whatever the path', () => {
  const laptop = device('laptop');
  const writes = [];
  for (let i = 0; i < 8; i++) { writes.push(laptop.note({ text: `v${i}` })); laptop.advance(3); }
  const rnd = mulberry32(99);
  const expected = writes[writes.length - 1];
  for (let i = 0; i < 40; i++) {
    const regs = foldOf(shuffle(rnd, writes));
    assert.equal(getValue(regs, NOTE, 'text'), 'v7');
    assert.equal(getRegister(regs, NOTE, 'text').stamp, expected.ts);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Adversarial convergence — reorder, duplicate, interleave, partition
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A realistic multi-device stream: concurrent same-field edits, a delete racing an edit, a
 * resurrect, a category delete with fan-out, a repeat toggle, publication and retraction. The
 * generator matters more than the assertions (ADR 005 §4.2).
 */
function trafficStream(seed) {
  const rnd = mulberry32(seed);
  const laptop = device('laptop', { short: SHORT.laptop });
  const desktop = device('desktop', { short: SHORT.desktop });
  const mama = device('mama', { member: MAMA, short: SHORT.mama });
  const papa = device('papa', { member: PAPA, short: SHORT.papa });
  const devs = [laptop, desktop, mama, papa];

  // ±10 minutes of clock skew between devices, plus one at +23 h (parked-adjacent but admitted).
  desktop.advance(-600000);
  mama.advance(600000);
  papa.advance(23 * 3600000);

  const ops = [];
  ops.push(laptop.note({ text: 'Zahnarzt', date: '2026-09-10', categoryId: 'cat-1', repeatsYearly: false, visibility: 'privat', coEdit: false, _alive: true }, { born: true }));
  ops.push(laptop.emit('cat.set', CAT, { name: 'Arzt', paletteRef: 'p1', visible: true, defaultVisibility: 'privat', _alive: true }, { born: true }));
  ops.push(desktop.emit('bar.set', BAR, { startDate: '2026-07-01', endDate: '2026-07-21', label: 'Urlaub', categoryId: 'cat-1', visibility: 'privat', coEdit: false, _alive: true }, { born: true }));

  for (let round = 0; round < 14; round++) {
    for (const d of devs) {
      d.advance(1 + Math.floor(rnd() * 40));
      const r = rnd();
      if (d.ctx.act === ME) {
        if (r < 0.2) ops.push(d.note({ date: `2026-09-${String(10 + round).padStart(2, '0')}` }));
        else if (r < 0.35) ops.push(d.note({ text: `Zahnarzt ${round}` }));
        else if (r < 0.45) ops.push(d.note({ _alive: false }));               // delete races the edit
        else if (r < 0.55) ops.push(d.note({ _alive: true }));                // undo resurrects (18.6)
        else if (r < 0.62) ops.push(d.note({ repeatsYearly: true, date: '2028-02-29' }));
        else if (r < 0.72) ops.push(d.emit('cat.set', CAT, { name: `Arzt ${round}` }));
        else if (r < 0.80) ops.push(d.emit('bar.set', BAR, { startDate: '2026-07-02', endDate: '2026-07-22' }));
        else if (r < 0.88) ops.push(d.emit('note.set', NOTE2, { categoryId: 'cat-2' }));   // fan-out
        else if (r < 0.94) ops.push(d.pub({ 'pub.level': 'geteilt', 'pub.text': `Zahnarzt ${round}`, 'pub.date': '2026-09-10', 'pub.alive': true, 'pub.coEdit': true }));
        else ops.push(d.pub({ 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null }));  // retraction
      } else if (r < 0.5) {
        ops.push(d.emit('pub.set', FNOTE, { 'pub.text': `co-edit ${d.name} ${round}` }));  // co-editor
      } else if (r < 0.75) {
        ops.push(d.emit('pub.set', FNOTE_MAMA, { 'pub.level': 'geteilt', 'pub.date': '2026-12-24', 'pub.text': 'Bescherung', 'pub.alive': true }));
      } else {
        ops.push(d.emit('member.set', `member:${d.ctx.act}`, { displayName: `${d.name}-${round}`, colorRef: `c${round % 5}` }));
      }
    }
    // devices gossip: absorbing a peer's stamp changes only FUTURE local stamps
    for (const d of devs) d.observe(ops[ops.length - 1].ts);
  }
  return { ops, rnd };
}

test('REORDER — 200 seeded shuffles of a 60-op multi-device stream all converge', () => {
  const { ops, rnd } = trafficStream(1234);
  assert.ok(ops.length > 50, `the generator produced only ${ops.length} ops`);
  const base = sig(foldOf(ops));
  for (let i = 0; i < 200; i++) {
    assert.equal(sig(foldOf(shuffle(rnd, ops))), base, `shuffle ${i} of seed 1234 diverged`);
  }
});

test('DUPLICATE — 15% random re-delivery on top of every shuffle changes nothing', () => {
  // Duplicate delivery needs no dedupe FOR CORRECTNESS (ADR 001 §6); a `seen` set is a
  // performance optimization only. This is the test that lets the sync client say so.
  const { ops, rnd } = trafficStream(555);
  const base = sig(foldOf(ops));
  for (let i = 0; i < 60; i++) {
    const stream = [];
    for (const o of shuffle(rnd, ops)) {
      stream.push(o);
      if (rnd() < 0.15) stream.push(o);
      if (rnd() < 0.03) stream.push(o, o);
    }
    assert.equal(sig(foldOf(stream)), base, `duplicate trial ${i} diverged`);
  }
});

test('INTERLEAVE — two replicas exchanging ops in any interleaving converge (P3)', () => {
  const { ops, rnd } = trafficStream(9001);
  const base = sig(foldOf(ops));
  for (let trial = 0; trial < 40; trial++) {
    // split into two "replicas", then interleave their deliveries arbitrarily
    const left = [], right = [];
    for (const o of shuffle(rnd, ops)) (rnd() < 0.5 ? left : right).push(o);
    const a = foldOf(left);
    const b = foldOf(right);
    // each replica now receives the other's ops in a random order
    const aFull = foldAll(cloneRegisters(a), shuffle(rnd, right));
    const bFull = foldAll(cloneRegisters(b), shuffle(rnd, left));
    assert.equal(sig(aFull), base, `replica A, trial ${trial}`);
    assert.equal(sig(bFull), sig(aFull), `replicas disagree, trial ${trial}`);
  }
});

test('PARTITION + HEAL — 2..8 replicas gossiping in a random order all land on one state', () => {
  const { ops, rnd } = trafficStream(31337);
  const base = sig(foldOf(ops));
  for (let k = 2; k <= 8; k++) {
    const parts = Array.from({ length: k }, () => []);
    shuffle(rnd, ops).forEach((o, i) => parts[i % k].push(o));
    const maps = parts.map((p) => foldOf(shuffle(rnd, p)));
    // heal by merging the maps pairwise in a random order — mergeMaps must be ACI too
    let merged = maps[0];
    for (const m of shuffle(rnd, maps.slice(1))) merged = mergeMaps(merged, m);
    assert.equal(sig(merged), base, `${k}-way partition diverged`);
    // and by replaying every op into every replica, which must give the same answer
    for (const m of maps) {
      assert.equal(sig(foldAll(cloneRegisters(m), shuffle(rnd, ops))), base);
    }
  }
});

test('CHECKPOINT TRANSPARENCY — fold(S) equals merge(checkpoint(S1), S2) for any split (P10)', () => {
  // ADR 001 §7.2: because per-field stamps are RETAINED in the checkpoint, a late-arriving op
  // OLDER than the horizon is compared against the retained stamp and wins or loses by the
  // identical rule. There is no coordination requirement and no risk.
  const { ops, rnd } = trafficStream(2718);
  const base = sig(foldOf(ops));
  for (let trial = 0; trial < 40; trial++) {
    const shuffled = shuffle(rnd, ops);
    const cut = Math.floor(rnd() * shuffled.length);
    const prefix = shuffled.slice(0, cut);
    const tail = shuffled.slice(cut);
    // the checkpoint is serialized and reloaded, exactly as compaction does it
    const checkpoint = deserializeRegisters(JSON.parse(JSON.stringify(serializeRegisters(foldOf(prefix)))));
    assert.equal(sig(mergeMaps(checkpoint, foldOf(tail))), base, `split at ${cut}`);
    assert.equal(sig(foldAll(checkpoint, tail)), base, `replay of the tail onto the checkpoint`);
  }
});

test('a THREE-WEEKS-LATE op arriving after compaction still wins or loses by the same rule (19.6)', () => {
  const laptop = device('laptop');
  const early = laptop.note({ text: 'vom Zug aus' });
  laptop.advance(21 * 24 * 3600000);
  const late = laptop.note({ text: 'heute' });

  // the offline Mac's op is authored FIRST but delivered LAST, after the other side compacted
  const compacted = deserializeRegisters(serializeRegisters(foldOf([late])));
  assert.equal(applyOp(compacted, early), false, 'the older op is absorbed, not applied');
  assert.equal(getValue(compacted, NOTE, 'text'), 'heute');

  // and the mirror: an op authored later but delivered after compaction genuinely wins
  const compacted2 = deserializeRegisters(serializeRegisters(foldOf([early])));
  assert.equal(applyOp(compacted2, late), true);
  assert.equal(getValue(compacted2, NOTE, 'text'), 'heute');
});

test('replaying an ALREADY-FOLDED stream reports no change for a single op (17.5)', () => {
  // The "neu" dot must not fire on old news. A full re-pull — which the sync client does after
  // any cursor confusion — has to be silent, in any order, with any duplication.
  const { ops, rnd } = trafficStream(4242);
  const regs = foldOf(ops);
  let noisy = 0;
  for (const o of shuffle(rnd, [...ops, ...ops])) if (applyOp(regs, o)) noisy++;
  assert.equal(noisy, 0, `${noisy} ops reported a change on a full replay`);
  assert.ok(ops.length > 50);
});

test('MONOTONE READS — no delivery order ever lowers a register stamp (P4)', () => {
  const { ops, rnd } = trafficStream(606);
  const regs = emptyRegisters();
  const highWater = new Map();
  for (const o of shuffle(rnd, ops)) {
    applyOp(regs, o);
    for (const [e, fields] of regs) {
      for (const [f, r] of fields) {
        const key = `${e}\u0000${f}`;
        const prev = highWater.get(key);
        if (prev !== undefined) assert.ok(r.stamp >= prev, `${key} went backwards`);
        highWater.set(key, r.stamp);
      }
    }
  }
  assert.ok(highWater.size > 10, `only ${highWater.size} registers observed`);
});

test('DELETE RACES EDIT — the outcome is dead-with-an-unread-new-text, in every order', () => {
  // ADR 001 §6: `_alive` is its own register. Delete at A, edit at B > A ⇒ dead, with the newer
  // text retained, so an explicit `_alive:true` (which is what undo emits, 18.6) brings back the
  // NEWEST content rather than the pre-delete content.
  const mac = device('laptop');
  const create = mac.note({ text: 'alt', _alive: true }, { born: true });
  mac.advance(10);
  const del = mac.note({ _alive: false });
  mac.advance(10);
  const edit = mac.note({ text: 'neu' });
  const rnd = mulberry32(11);
  for (let i = 0; i < 30; i++) {
    const regs = foldOf(shuffle(rnd, [create, del, edit]));
    assert.equal(getValue(regs, NOTE, '_alive'), false);
    assert.equal(getValue(regs, NOTE, 'text'), 'neu');
  }
  mac.advance(10);
  const resurrect = mac.note({ _alive: true });
  for (let i = 0; i < 30; i++) {
    const regs = foldOf(shuffle(rnd, [create, del, edit, resurrect]));
    assert.equal(getValue(regs, NOTE, '_alive'), true);
    assert.equal(getValue(regs, NOTE, 'text'), 'neu', 'the resurrect brings back the NEWEST text');
  }
});

test('CONCURRENT MOVE + EDIT of one note converge to "both applied" (18.5)', () => {
  const laptop = device('laptop', { short: SHORT.laptop });
  const desktop = device('desktop', { short: SHORT.desktop });
  const move = laptop.note({ date: '2026-09-14' });
  const edit = desktop.note({ text: 'Zahnarzt 15:00' });   // same ms, different device
  const rnd = mulberry32(3);
  for (let i = 0; i < 20; i++) {
    const regs = foldOf(shuffle(rnd, [move, edit]));
    assert.equal(getValue(regs, NOTE, 'date'), '2026-09-14');
    assert.equal(getValue(regs, NOTE, 'text'), 'Zahnarzt 15:00');
  }
});

test('FAN-OUT converges under partial delivery — one gid, N independent registers (legend.js:197)', () => {
  const mac = device('laptop');
  const targets = Array.from({ length: 12 }, (_, i) => `note:fan-${i}`);
  const gid = 'D'.repeat(22);
  const fan = targets.map((e) => mac.emit('note.set', e, { categoryId: 'cat-2' }, { gid }));
  fan.push(mac.emit('cat.set', CAT, { _alive: false }, { gid }));
  const rnd = mulberry32(77);
  const base = sig(foldOf(fan));
  for (let i = 0; i < 30; i++) {
    // deliver a random half first, then the rest — a half-reassigned board that converges
    const s = shuffle(rnd, fan);
    const half = foldOf(s.slice(0, 6));
    assert.ok(registerCount(half) > 0);
    assert.equal(sig(foldAll(half, s.slice(6))), base);
  }
  assert.equal(new Set(fan.map((o) => o.gid)).size, 1, 'one user action, one gid (rule U1)');
});

test('`gid` has no effect on the merge whatsoever (ADR 001 §2)', () => {
  const mac = device('laptop');
  const a = mac.emit('note.set', NOTE, { text: 'x' }, { gid: 'D'.repeat(22) });
  const b = { ...a, id: 'z'.repeat(22), gid: 'E'.repeat(22) };
  const withA = foldOf([a]);
  const withB = foldOf([b]);
  assert.equal(getValue(withA, NOTE, 'text'), getValue(withB, NOTE, 'text'));
  assert.equal(getRegister(withA, NOTE, 'text').stamp, getRegister(withB, NOTE, 'text').stamp);
});

// ═════════════════════════════════════════════════════════════════════════════
// E. R9 — `null` is a value that WINS and CLEARS. Absence is not.
// ═════════════════════════════════════════════════════════════════════════════

test('an explicit null WINS against an older value and clears the field', () => {
  const mac = device('laptop');
  const set = mac.emit('cat.set', CAT, { nameEn: 'Doctor' });
  mac.advance(5);
  const clear = mac.emit('cat.set', CAT, { name: 'Arzt', nameEn: null });   // legend.js:116, DE rename
  const regs = foldOf([set, clear]);
  assert.equal(getValue(regs, CAT, 'nameEn'), null);
  assert.equal(getValue(regs, CAT, 'name'), 'Arzt');
});

test('a null register EXISTS — it is not the same thing as a field that was never written', () => {
  const mac = device('laptop');
  const regs = foldOf([mac.emit('cat.set', CAT, { nameEn: null })]);
  assert.equal(hasRegister(regs, CAT, 'nameEn'), true, 'written, cleared, and it won');
  assert.equal(getValue(regs, CAT, 'nameEn'), null);
  assert.notEqual(getRegister(regs, CAT, 'nameEn'), undefined);

  assert.equal(hasRegister(regs, CAT, 'paletteRef'), false, 'never written');
  assert.equal(getValue(regs, CAT, 'paletteRef'), undefined);
  assert.equal(getRegister(regs, CAT, 'paletteRef'), undefined);
  assert.deepEqual(fieldNames(regs, CAT), ['nameEn']);
});

test('an older null LOSES — a re-share after a retraction restores the text', () => {
  const mac = device('laptop');
  const retract = mac.pub({ 'pub.text': null, 'pub.level': 'belegt' });
  mac.advance(5);
  const reshare = mac.pub({ 'pub.text': 'Zahnarzt', 'pub.level': 'geteilt' });
  const rnd = mulberry32(5);
  for (let i = 0; i < 20; i++) {
    const regs = foldOf(shuffle(rnd, [retract, reshare]));
    assert.equal(getValue(regs, FNOTE, 'pub.text'), 'Zahnarzt');
    assert.equal(getValue(regs, FNOTE, 'pub.level'), 'geteilt');
  }
});

test('R9 — OMISSION IS NOT WITHDRAWAL: the exact defect ADR 004 §5.1 describes', () => {
  // Geteilt: the peer holds `pub.text`. Then I downgrade to Belegt.
  const mac = device('laptop');
  const share = mac.pub({ 'pub.level': 'geteilt', 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.alive': true, 'pub.coEdit': false });
  mac.advance(50);

  // (a) THE BUG. A downgrade patch that merely OMITS pub.text. No register write occurs, the old
  //     register keeps its value AND its stamp, and every peer keeps rendering the text — while
  //     my own board looks correctly downgraded. No owner-side smoke test catches this.
  const buggy = mac.pub({ 'pub.level': 'belegt' });
  const peerBuggy = foldOf([share, buggy]);
  assert.equal(getValue(peerBuggy, FNOTE, 'pub.level'), 'belegt');
  assert.equal(getValue(peerBuggy, FNOTE, 'pub.text'), 'Zahnarzt',
    'this is the leak — the join cannot fix an op that never wrote the register');

  // (b) THE RULE. A downgrade writes an explicit null to every content register it withdraws.
  const correct = mac.pub({ 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null });
  const peerFixed = foldOf([share, correct]);
  assert.equal(getValue(peerFixed, FNOTE, 'pub.level'), 'belegt');
  assert.equal(getValue(peerFixed, FNOTE, 'pub.text'), null, 'withdrawn');
  assert.equal(hasRegister(peerFixed, FNOTE, 'pub.text'), true, 'and the register still exists');
  assert.equal(getValue(peerFixed, FNOTE, 'pub.date'), '2026-09-10', 'Belegt keeps the date');
});

test('R9 — a peer that NEVER SAW the Geteilt op lands on the same retracted state', () => {
  // The argmax rule ignores intermediates: a peer joining after the retraction, or one that lost
  // the share op entirely, folds to exactly the same registers (ADR 004 §5.3 mechanism 1).
  const mac = device('laptop');
  const share = mac.pub({ 'pub.level': 'geteilt', 'pub.text': 'Zahnarzt', 'pub.alive': true, 'pub.date': '2026-09-10' });
  mac.advance(50);
  const retract = mac.pub({ 'pub.level': 'privat', 'pub.alive': false, 'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null });

  const sawBoth = foldOf([share, retract]);
  const sawOnlyRetraction = foldOf([retract]);
  for (const f of ['pub.text', 'pub.date']) {
    assert.equal(getValue(sawBoth, FNOTE, f), null, f);
    assert.equal(getValue(sawOnlyRetraction, FNOTE, f), null, f);
  }
  assert.equal(getValue(sawBoth, FNOTE, 'pub.alive'), false);
  assert.equal(getValue(sawBoth, FNOTE, 'pub.level'), 'privat');
});

test('R9 — no ordering of a random transition sequence ending in privat leaves content (P7d)', () => {
  const rnd = mulberry32(808);
  for (let trial = 0; trial < 30; trial++) {
    const mac = device('laptop');
    const ops = [];
    for (let i = 0; i < 6; i++) {
      const level = VISIBILITY_LEVELS[Math.floor(rnd() * 3)];
      mac.advance(3 + Math.floor(rnd() * 20));
      if (level === 'geteilt') ops.push(mac.pub({ 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.text': `t${i}`, 'pub.repeatsYearly': false, 'pub.coEdit': true }));
      else if (level === 'belegt') ops.push(mac.pub({ 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.repeatsYearly': false, 'pub.text': null, 'pub.coEdit': null }));
      else ops.push(mac.pub({ 'pub.level': 'privat', 'pub.alive': false, 'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null }));
    }
    mac.advance(100);
    ops.push(mac.pub({ 'pub.level': 'privat', 'pub.alive': false, 'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null }));
    const regs = foldOf(shuffle(rnd, ops));
    for (const [f, r] of registersOf(regs, FNOTE)) {
      if (f === 'pub.level') assert.equal(r.value, 'privat');
      else if (f === 'pub.alive') assert.equal(r.value, false);
      else assert.equal(r.value, null, `${f} survived the retraction in trial ${trial}`);
    }
  }
});

test('false and 0 survive the join — the classic falsy-drop bug', () => {
  const mac = device('laptop');
  const regs = foldOf([
    mac.emit('note.set', NOTE, { repeatsYearly: false, coEdit: false, _alive: false }),
    mac.emit('pref.set', 'pref:app', { rowHeight: 0, seenFirstRun: false }),
  ]);
  assert.equal(getValue(regs, NOTE, 'repeatsYearly'), false);
  assert.equal(getValue(regs, NOTE, '_alive'), false);
  assert.equal(getValue(regs, 'pref:app', 'rowHeight'), 0);
  assert.equal(getValue(regs, 'pref:app', 'seenFirstRun'), false);
  assert.equal(hasRegister(regs, 'pref:app', 'rowHeight'), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// F. The two namespaces — truth vs `pub.*` (ADR 004 §1)
// ═════════════════════════════════════════════════════════════════════════════

test('a truth write and a publication write land in DIFFERENT entities with INDEPENDENT stamps', () => {
  const mac = device('laptop');
  const truth = mac.note({ text: 'Zahnarzt' });
  mac.advance(5);
  const pub = mac.pub({ 'pub.text': 'Zahnarzt' });
  const regs = foldOf([truth, pub]);
  assert.deepEqual(entityKeys(regs).sort(), [FNOTE, NOTE].sort());
  assert.equal(getValue(regs, NOTE, 'text'), 'Zahnarzt');
  assert.equal(getValue(regs, FNOTE, 'pub.text'), 'Zahnarzt');
  assert.notEqual(getRegister(regs, NOTE, 'text').stamp, getRegister(regs, FNOTE, 'pub.text').stamp);
  assert.equal(getRegister(regs, NOTE, 'pub.text'), undefined, 'no pub.* register on a truth key');
  assert.equal(getRegister(regs, FNOTE, 'text'), undefined, 'no truth field on a family key');
});

test('the join refuses to write a pub.* field onto a truth entity, and vice versa', () => {
  const regs = emptyRegisters();
  assert.throws(() => applyOp(regs, op({ e: NOTE, f: { 'pub.text': 'leak' } })), RegisterError);
  assert.throws(() => applyOp(regs, op({ e: FNOTE, k: 'pub.set', space: FSP, f: { text: 'leak' } })), RegisterError);
  assert.throws(() => applyOp(regs, op({ e: FNOTE, k: 'pub.set', space: FSP, f: { visibility: 'geteilt' } })), RegisterError);
  assert.equal(regs.size, 0);
});

test('A3 — there is no pub.categoryId register and the join will not create one', () => {
  // Enforced by the ABSENCE of a field from FIELDS, not by a filter someone can forget.
  const regs = emptyRegisters();
  assert.throws(() => applyOp(regs, op({ e: FNOTE, k: 'pub.set', space: FSP, f: { 'pub.categoryId': 'cat-1' } })),
    (e) => e instanceof RegisterError && /no field/.test(e.message));
  assert.throws(() => applyOp(regs, op({ e: FNOTE, k: 'pub.set', space: FSP, f: { categoryId: 'cat-1' } })), RegisterError);
  for (const kind of ['fnote', 'fbar']) {
    assert.equal(Object.keys(FIELDS[kind]).some((f) => /categor/i.test(f)), false, kind);
  }
});

test('the pub-field mapping is a bijection over the co-editable fields of note/bar', () => {
  for (const truthKind of ['note', 'bar']) {
    const famKind = FAMILY_OF[truthKind];
    const truthCo = coEditableFields(truthKind).sort();
    const famCo = coEditableFields(famKind).sort();
    assert.deepEqual(truthCo.map(pubFieldFor).sort(), famCo,
      `every co-editable ${truthKind} field has exactly one co-editable ${famKind} counterpart`);
    assert.deepEqual(famCo.map(truthFieldFor).sort(), truthCo);
    assert.equal(TRUTH_OF[famKind], truthKind);
  }
  assert.equal(truthFieldFor('text'), null);
  assert.equal(pubFieldFor('text'), 'pub.text');
});

test('governing fields have no truth counterpart the promotion could reach', () => {
  // pub.level / pub.coEdit / pub.alive are `gov: true` and therefore never promoted. A peer can
  // never write my `visibility`, my `coEdit` or my `_alive` through the family space.
  for (const famKind of ['fnote', 'fbar']) {
    // ADR 001 §4.3 stage 3a: "pub.level, pub.coEdit, pub.alive, _born" — owner or admin only.
    const gov = governingFields(famKind);
    assert.deepEqual(gov.sort(), ['_born', 'pub.alive', 'pub.coEdit', 'pub.level']);
    for (const g of gov) assert.equal(coEditableFields(famKind).includes(g), false, g);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// G. The promotion asymmetry — ADR 004 §4.1, INV-R3, property P7c
// ═════════════════════════════════════════════════════════════════════════════

/** Geteilt note with a publication, then a Geteilt→Belegt downgrade. The exact 18.2 scenario. */
function downgradeScenario() {
  const laptop = device('laptop', { short: SHORT.laptop });
  const ops = [];
  ops.push(laptop.note({ text: 'Zahnarzt', date: '2026-09-10', visibility: 'geteilt', coEdit: false, _alive: true }, { born: true }));
  laptop.advance(10);
  ops.push(laptop.pub({ 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.repeatsYearly': false, 'pub.coEdit': false }));
  laptop.advance(500);
  // the downgrade: one txn, the truth write plus the publication write (ADR 004 §5)
  ops.push(laptop.note({ visibility: 'belegt' }));
  ops.push(laptop.pub({ 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null }));
  return { laptop, ops };
}

test('P7c — a Belegt downgrade does NOT blank my own note', () => {
  // "Never promote my own pub.* writes. They are projections OF the truth, not edits TO it."
  // Without the asymmetry the `pub.text: null` written 500 ms after my truth text would win the
  // max-by-stamp and my own board would go blank. This is the single scenario the rule exists
  // for; ADR 004 §4.1 calls it the correctness heart of the document.
  const { ops } = downgradeScenario();
  const rnd = mulberry32(1);
  for (let i = 0; i < 30; i++) {
    const regs = foldOf(shuffle(rnd, ops));
    assert.equal(getValue(regs, FNOTE, 'pub.text'), null, 'the peer sees the withdrawal');
    const eff = promoteEntity(regs, NOTE, ME);
    assert.equal(eff.get('text').value, 'Zahnarzt', 'my own text survives my own retraction');
    assert.equal(eff.get('date').value, '2026-09-10');
  }
});

test('P7c — and it survives on my SECOND Mac, because `author` is the member', () => {
  // The retraction was authored on the laptop; the desktop folds the same ops. `author` is
  // `op.act` (the member), so the desktop declines to promote it too. Were `author` the DEVICE,
  // this assertion would fail and my note would be blank on the other machine.
  const { ops } = downgradeScenario();
  const regs = foldOf(ops);
  const eff = promoteEntity(regs, NOTE, ME);
  assert.equal(eff.get('text').value, 'Zahnarzt');
  const authors = [...registersOf(regs, FNOTE).values()].map((r) => r.author);
  assert.deepEqual([...new Set(authors)], [ME], 'every publication register is authored by the member');
});

test('a → Privat retraction does not blank my own note either', () => {
  const laptop = device('laptop');
  const truth = laptop.note({ text: 'Zahnarzt', date: '2026-09-10', visibility: 'geteilt' }, { born: true });
  laptop.advance(400);
  const retract = laptop.pub({ 'pub.level': 'privat', 'pub.alive': false, 'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null });
  const regs = foldOf([truth, retract]);
  const eff = promoteEntity(regs, NOTE, ME);
  assert.equal(eff.get('text').value, 'Zahnarzt');
  assert.equal(eff.get('date').value, '2026-09-10');
  assert.equal(getValue(regs, FNOTE, 'pub.date'), null, 'while the peer sees nothing');
});

test('THE MIRROR — a CO-EDITOR\'s newer pub write IS promoted onto my truth (18.5)', () => {
  // The test above cannot pass by promoting nothing. Mama holds pub.coEdit and edits the text.
  const { ops } = downgradeScenario();
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 900 });
  const coEdit = mama.emit('pub.set', FNOTE, { 'pub.text': 'Zahnarzt 15:00' });
  const rnd = mulberry32(2);
  for (let i = 0; i < 30; i++) {
    const regs = foldOf(shuffle(rnd, [...ops, coEdit]));
    const eff = promoteEntity(regs, NOTE, ME);
    assert.equal(eff.get('text').value, 'Zahnarzt 15:00', 'Mama\'s edit reaches my truth');
    assert.equal(eff.get('text').author, MAMA);
  }
});

test('a co-editor\'s OLDER write loses to my newer truth — promotion is max-by-stamp, not "pub wins"', () => {
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 });
  const coEdit = mama.emit('pub.set', FNOTE, { 'pub.text': 'alt von Mama' });
  const laptop = device('laptop', { startMs: 1787836800000 + 5000 });
  const mine = laptop.note({ text: 'neu von mir' });
  const rnd = mulberry32(6);
  for (let i = 0; i < 20; i++) {
    const eff = promoteEntity(foldOf(shuffle(rnd, [coEdit, mine])), NOTE, ME);
    assert.equal(eff.get('text').value, 'neu von mir');
  }
});

test('a co-editor CAN clear a field with an explicit null — R9 through the promotion path', () => {
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'Zahnarzt' });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 5000 });
  const cleared = mama.emit('pub.set', FNOTE, { 'pub.text': null });
  const eff = promoteEntity(foldOf([mine, cleared]), NOTE, ME);
  assert.equal(eff.get('text').value, null, 'null is a value and it is promoted like any other');
  assert.equal(eff.get('text').author, MAMA);
});

// ─────────────────────────────────────────────────────────────────────────────
// The 18.3 / R9 boundary: an ADMIN UNSHARE must not blank my truth, and a CO-EDITOR'S
// null must. Both halves are pinned, because the tempting one-line "fix" for either
// breaks the other. See `registers.js:withdrawnByOther` for the full argument.
// ─────────────────────────────────────────────────────────────────────────────

/** The admin unshare of ADR 004 §5: ONE op, `pub.level:'privat'` + every pub field null. */
function adminUnshare(dev, admin = PAPA) {
  return dev.emit('pub.set', FNOTE, {
    'pub.level': 'privat', 'pub.alive': false,
    'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null,
  }, { act: admin });
}

test('18.3 — an ADMIN unshare never blanks the owner\'s own truth (INV-R3)', () => {
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'Zahnarzt', date: '2026-09-10', visibility: 'geteilt' }, { born: true });
  const admin = device('papa', { member: PAPA, short: SHORT.papa, startMs: 1787836800000 + 9000 });
  const unshare = adminUnshare(admin, PAPA);

  const rnd = mulberry32(1803);
  for (let i = 0; i < 30; i++) {
    const regs = foldOf(shuffle(rnd, [mine, unshare]));
    // The peer's view IS withdrawn — that is the whole point of the unshare…
    assert.equal(getValue(regs, FNOTE, 'pub.text'), null, 'the family space must lose the text');
    assert.equal(getValue(regs, FNOTE, 'pub.level'), 'privat');
    // …while my own board keeps telling me the truth.
    const eff = promoteEntity(regs, NOTE, ME);
    assert.equal(eff.get('text').value, 'Zahnarzt', 'a redaction can never make my own board lie to me');
    assert.equal(eff.get('date').value, '2026-09-10');
    assert.equal(eff.get('text').author, ME, 'and it is still MY register, not a promoted one');
  }
});

test('withdrawnByOther fires ONLY on a third party\'s retraction', () => {
  const reg = (value, author) => ({ value, stamp: stampAt(1), author, op: 'z'.repeat(22) });
  const cells = (o) => new Map(Object.entries(o));

  assert.equal(withdrawnByOther(undefined, ME), false, 'no publication at all');
  assert.equal(withdrawnByOther(cells({}), ME), false);
  assert.equal(withdrawnByOther(cells({ 'pub.level': reg('geteilt', ME) }), ME), false);
  assert.equal(withdrawnByOther(cells({ 'pub.level': reg('belegt', ME) }), ME), false,
    'Belegt is a DOWNGRADE, not a withdrawal — a co-editor\'s edits still promote');
  assert.equal(withdrawnByOther(cells({ 'pub.level': reg('privat', ME) }), ME), false,
    'MY OWN retraction is handled by the author asymmetry, not by this gate');
  assert.equal(withdrawnByOther(cells({ 'pub.level': reg('privat', PAPA) }), ME), true);
  assert.equal(withdrawnByOther(cells({ 'pub.alive': reg(false, PAPA) }), ME), true);
  assert.equal(withdrawnByOther(cells({ 'pub.alive': reg(true, PAPA) }), ME), false);
});

test('18.2 / R9 survives the 18.3 gate — a co-editor\'s null still clears my field', () => {
  // The gate must be narrow. `pub.level` is still 'geteilt', so this is an EDIT, not a
  // withdrawal, and `null` is a first-class value (ADR 004 §5.1).
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'Zahnarzt', date: '2026-09-10', visibility: 'geteilt' }, { born: true });
  const share = laptop.pub({ 'pub.level': 'geteilt', 'pub.alive': true, 'pub.coEdit': true, 'pub.text': 'Zahnarzt' });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 5000 });
  const cleared = mama.emit('pub.set', FNOTE, { 'pub.text': null });

  const rnd = mulberry32(1802);
  for (let i = 0; i < 30; i++) {
    const eff = promoteEntity(foldOf(shuffle(rnd, [mine, share, cleared])), NOTE, ME);
    assert.equal(eff.get('text').value, null, 'a co-editor clearing a field is an edit and it reaches my truth');
    assert.equal(eff.get('text').author, MAMA);
  }
});

test('CHARACTERIZED — my own retraction reverts my board to MY truth, dropping a co-editor\'s edit', () => {
  // NOT a consequence of the 18.3 gate — this is how promotion has always worked, and the gate
  // does not fire here (the retraction is authored by ME). It is recorded because it is
  // surprising and someone will otherwise "fix" it into a bug:
  //
  //   promotion is a VIEW, not a merge into truth. Mama's co-edit lives ONLY in the `pub.text`
  //   register; it is never copied into `note:…/text`. My own retraction overwrites that same
  //   register with `null` at a greater stamp, so there is no longer a foreign write to promote,
  //   and my board falls back to my own — now stale — truth.
  //
  // ADR 004 §5 says the owner's client reconciles in a FOLLOW-UP TXN after a transition. That
  // txn is where a co-editor's accepted text should be written into the truth, and it belongs to
  // WP-10 (`project.js`), not to the join. Flagged in the WP-1 report as an open question for the
  // PO: today, taking a co-edited entry private silently discards the co-editor's wording.
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'alt', date: '2026-09-10', visibility: 'geteilt' }, { born: true });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 5000 });
  const hers = mama.emit('pub.set', FNOTE, { 'pub.text': 'von Mama' });

  // Before the retraction, her edit is on my board — that is 18.2 working.
  assert.equal(promoteEntity(foldOf([mine, hers]), NOTE, ME).get('text').value, 'von Mama');

  laptop.setClock(1787836800000 + 9000);
  const retract = laptop.pub({
    'pub.level': 'privat', 'pub.alive': false,
    'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null, 'pub.coEdit': null,
  });

  const rnd = mulberry32(1804);
  for (let i = 0; i < 30; i++) {
    const eff = promoteEntity(foldOf(shuffle(rnd, [mine, hers, retract])), NOTE, ME);
    assert.equal(eff.get('text').value, 'alt', 'my truth, not blank — INV-R3 holds either way');
    assert.equal(eff.get('text').author, ME);
  }
});

test('a co-editor can write a field I never set at all', () => {
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'Zahnarzt' }, { born: true });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 5000 });
  const theirs = mama.emit('pub.set', FNOTE, { 'pub.date': '2026-12-24' });
  const eff = promoteEntity(foldOf([mine, theirs]), NOTE, ME);
  assert.equal(eff.get('date').value, '2026-12-24');
  assert.equal(eff.get('text').value, 'Zahnarzt');
});

test('promotion touches ONLY co-editable fields — never visibility, coEdit or _alive', () => {
  const laptop = device('laptop');
  const mine = laptop.note({ text: 't', visibility: 'geteilt', coEdit: true, _alive: true }, { born: true });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 9000 });
  // a hostile peer writing the governing registers: authorization rejects these one layer up
  // (ADR 001 §4.3 stage 3a), and even if one slipped through, the join keeps them in the family
  // namespace where the owner's projection never reads them.
  const hostile = mama.emit('pub.set', FNOTE, { 'pub.level': 'privat', 'pub.alive': false, 'pub.coEdit': false });
  const eff = promoteEntity(foldOf([mine, hostile]), NOTE, ME);
  assert.equal(eff.get('visibility').value, 'geteilt');
  assert.equal(eff.get('coEdit').value, true);
  assert.equal(eff.get('_alive').value, true);
  assert.equal(eff.get('_born').author, ME);
});

test('promoteEntity leaves the register map untouched and returns a fresh Map', () => {
  const { ops } = downgradeScenario();
  const regs = foldOf(ops);
  const before = sig(regs);
  const eff = promoteEntity(regs, NOTE, ME);
  eff.set('text', { value: 'tampered', stamp: stampAt(9e12), author: ME, op: 'z'.repeat(22) });
  assert.equal(sig(regs), before);
  assert.equal(getValue(regs, NOTE, 'text'), 'Zahnarzt');
});

test('promoteEntity is a no-op for entities with no family counterpart', () => {
  const mac = device('laptop');
  const regs = foldOf([
    mac.emit('cat.set', CAT, { name: 'Arzt', visible: true }),
    mac.emit('pad.set', 'pad:2026-09', { text: 'Einkaufen' }),
  ]);
  assert.deepEqual([...promoteEntity(regs, CAT, ME).keys()].sort(), ['name', 'visible']);
  assert.deepEqual([...promoteEntity(regs, 'pad:2026-09', ME).keys()], ['text']);
});

test('promoteEntity refuses a family key — a viewer reads pub.* only and never promotes', () => {
  const regs = foldOf([device('mama', { member: MAMA, short: SHORT.mama })
    .emit('pub.set', FNOTE_MAMA, { 'pub.level': 'geteilt', 'pub.text': 'Bescherung' })]);
  assert.throws(() => promoteEntity(regs, FNOTE_MAMA, ME),
    (e) => e instanceof RegisterError && /viewer reads pub/.test(e.message));
  assert.throws(() => promoteEntity(regs, `member:${MAMA}`, ME), RegisterError);
});

test('promotion never reaches ANOTHER member\'s publication of the same uuid', () => {
  // `fnote:<mem>/<uuid>` — ownership is a literal segment of the key (ADR 001 §4.4). A member who
  // republishes my uuid under their own memberId addresses a different register cell entirely.
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'Zahnarzt' }, { born: true });
  const impostor = device('papa', { member: PAPA, short: SHORT.papa, startMs: 1787836800000 + 9e6 });
  const forged = impostor.emit('pub.set', familyKey('fnote', PAPA, '5e1a-4b2c-9c'), { 'pub.text': 'geklaut' });
  const regs = foldOf([mine, forged]);
  assert.equal(promoteEntity(regs, NOTE, ME).get('text').value, 'Zahnarzt');
  assert.equal(getValue(regs, familyKey('fnote', PAPA, '5e1a-4b2c-9c'), 'pub.text'), 'geklaut',
    'their op is applied — to THEIR entity, where it cannot touch mine');
});

test('promoteRegister demands a real MemberId — an undefined `me` would promote my own retractions', () => {
  const truth = { value: 'Zahnarzt', stamp: stampAt(1000), author: ME, op: 'a'.repeat(22) };
  const own = { value: null, stamp: stampAt(2000), author: ME, op: 'b'.repeat(22) };
  assert.equal(promoteRegister(truth, own, ME), truth);
  for (const bad of [undefined, null, '', 'me', PAPA.slice(4)]) {
    assert.throws(() => promoteRegister(truth, own, bad), RegisterError, `me = ${JSON.stringify(bad)}`);
  }
  assert.throws(() => promoteEntity(emptyRegisters(), NOTE, undefined), RegisterError);
});

test('promoteRegister handles every undefined combination without inventing a register', () => {
  const truth = { value: 't', stamp: stampAt(1000), author: ME, op: 'a'.repeat(22) };
  const foreign = { value: 'f', stamp: stampAt(2000), author: MAMA, op: 'b'.repeat(22) };
  assert.equal(promoteRegister(undefined, undefined, ME), undefined);
  assert.equal(promoteRegister(truth, undefined, ME), truth);
  assert.equal(promoteRegister(undefined, foreign, ME), foreign);
  assert.equal(promoteRegister(undefined, { ...foreign, author: ME }, ME), undefined,
    'my own publication is never promoted, even onto nothing');
});

// ═════════════════════════════════════════════════════════════════════════════
// H. mergeMaps
// ═════════════════════════════════════════════════════════════════════════════

test('mergeMaps is commutative, associative and idempotent', () => {
  const { a, b, c } = aciSets();
  const A = foldOf(a), B = foldOf(b), C = foldOf(c);
  assert.equal(sig(mergeMaps(A, B)), sig(mergeMaps(B, A)));
  assert.equal(sig(mergeMaps(mergeMaps(A, B), C)), sig(mergeMaps(A, mergeMaps(B, C))));
  assert.equal(sig(mergeMaps(A, A)), sig(A));
  assert.equal(sig(mergeMaps(A, emptyRegisters())), sig(A));
  assert.equal(sig(mergeMaps(emptyRegisters(), A)), sig(A));
});

test('mergeMaps returns a new map and mutates neither argument', () => {
  const { a, b } = aciSets();
  const A = foldOf(a), B = foldOf(b);
  const sa = sig(A), sb = sig(B);
  const m = mergeMaps(A, B);
  assert.notEqual(m, A);
  assert.notEqual(m, B);
  assert.equal(sig(A), sa);
  assert.equal(sig(B), sb);
  m.set('note:injected', new Map());
  assert.equal(sig(A), sa);
  assert.equal(sig(B), sb);
});

test('mergeMaps rejects anything that is not a RegisterMap', () => {
  assert.throws(() => mergeMaps({}, emptyRegisters()), RegisterError);
  assert.throws(() => mergeMaps(emptyRegisters(), null), RegisterError);
  assert.throws(() => foldAll([], []), RegisterError);
});

test('mergeMaps resolves field by field, not entity by entity', () => {
  const laptop = device('laptop', { short: SHORT.laptop });
  const desktop = device('desktop', { short: SHORT.desktop });
  laptop.advance(100);
  const A = foldOf([laptop.note({ text: 'neu', date: '2026-01-01' })]);
  desktop.advance(200);
  const B = foldOf([desktop.note({ date: '2026-06-06' })]);
  const m = mergeMaps(A, B);
  assert.equal(getValue(m, NOTE, 'text'), 'neu', 'a field only B lacks survives');
  assert.equal(getValue(m, NOTE, 'date'), '2026-06-06', 'the newer field wins');
});

// ═════════════════════════════════════════════════════════════════════════════
// I. Serialization — the checkpoint payload
// ═════════════════════════════════════════════════════════════════════════════

test('serialize → JSON → parse → deserialize is the identity', () => {
  const { ops } = trafficStream(4001);
  const regs = foldOf(ops);
  const round = deserializeRegisters(JSON.parse(JSON.stringify(serializeRegisters(regs))));
  assert.deepEqual(round, regs);
  assert.equal(sig(round), sig(regs));
  assert.equal(registerCount(round), registerCount(regs));
});

test('the serialized form is KEY-SORTED, so two fold orders produce byte-identical checkpoints', () => {
  // This is what makes "did these two devices converge?" a string comparison, in a test, in a
  // diagnostic and in the fleet harness.
  const { ops, rnd } = trafficStream(4002);
  const a = JSON.stringify(serializeRegisters(foldOf(shuffle(rnd, ops))));
  const b = JSON.stringify(serializeRegisters(foldOf(shuffle(rnd, ops))));
  assert.equal(a, b);
  const blob = serializeRegisters(foldOf(ops));
  assert.deepEqual(Object.keys(blob.regs), [...Object.keys(blob.regs)].sort());
  for (const e of Object.keys(blob.regs)) {
    assert.deepEqual(Object.keys(blob.regs[e]), [...Object.keys(blob.regs[e])].sort(), e);
  }
});

test('a serialized register retains value, stamp, author and the opId tiebreak', () => {
  const mac = device('laptop');
  const o = mac.note({ text: 'Zahnarzt' });
  const blob = serializeRegisters(foldOf([o]));
  assert.equal(blob.v, REGISTER_FORMAT);
  assert.deepEqual(blob.regs[NOTE].text, { value: 'Zahnarzt', stamp: o.ts, author: ME, op: o.id });
});

test('null and false survive serialization — a dropped key would resurrect the old value', () => {
  const mac = device('laptop');
  const regs = foldOf([mac.emit('cat.set', CAT, { nameEn: null, visible: false })]);
  const json = JSON.stringify(serializeRegisters(regs));
  assert.match(json, /"value":null/);
  assert.match(json, /"value":false/);
  const back = deserializeRegisters(JSON.parse(json));
  assert.equal(getValue(back, CAT, 'nameEn'), null);
  assert.equal(hasRegister(back, CAT, 'nameEn'), true);
  assert.equal(getValue(back, CAT, 'visible'), false);
});

test('deserializeRegisters refuses a corrupt checkpoint rather than poisoning the order', () => {
  const good = serializeRegisters(foldOf([device('laptop').note({ text: 'x' })]));
  const bend = (fn) => {
    const b = JSON.parse(JSON.stringify(good));
    fn(b);
    return b;
  };
  const cases = [
    [null, 'not an object'],
    [[], 'not an object'],
    [bend((b) => { b.v = 99; }), 'format version'],
    [bend((b) => { delete b.regs; }), 'not an object'],
    [bend((b) => { b.regs['nocolon'] = {}; }), 'entity key'],
    [bend((b) => { b.regs[NOTE] = 7; }), 'field bag'],
    [bend((b) => { b.regs[NOTE].text = 'nope'; }), 'not a register'],
    [bend((b) => { b.regs[NOTE].text.stamp = 'bad'; }), 'stamp'],
    [bend((b) => { b.regs[NOTE].text.author = 'nope'; }), 'author'],
    [bend((b) => { delete b.regs[NOTE].text.value; }), 'no value'],
    [bend((b) => { b.regs[NOTE].text.value = { a: 1 }; }), 'scalar'],
    [bend((b) => { b.regs[NOTE].text.op = 'short'; }), 'op id'],
  ];
  for (const [blob, needle] of cases) {
    assert.throws(() => deserializeRegisters(blob),
      (e) => e instanceof RegisterError && e.message.includes(needle),
      `expected a RegisterError mentioning "${needle}"`);
  }
});

test('deserializeRegisters is TOLERANT of a field name this build does not know', () => {
  // A checkpoint is our own already-admitted state. Dropping an unknown register is how a
  // downgrade to an older build turns "does not show the new thing" into "loses the new thing"
  // — the same reasoning that parks an unknown op (ADR 001 §7.4, §8.4).
  const blob = serializeRegisters(foldOf([device('laptop').note({ text: 'x' })]));
  blob.regs[NOTE].futureField = { value: 42, stamp: stampAt(9000), author: MAMA, op: 'f'.repeat(22) };
  blob.regs['frecipe:mem_' + 'A'.repeat(22) + '/xyz'] = { servings: { value: 4, stamp: stampAt(9000), author: MAMA, op: 'g'.repeat(22) } };
  const back = deserializeRegisters(blob);
  assert.equal(getValue(back, NOTE, 'futureField'), 42);
  assert.equal(getValue(back, 'frecipe:mem_' + 'A'.repeat(22) + '/xyz', 'servings'), 4);
  assert.equal(sig(back), JSON.stringify(serializeRegisters(back)), 'and it round-trips again');
});

test('a deserialized checkpoint hands back frozen registers, exactly like the join', () => {
  const back = deserializeRegisters(serializeRegisters(foldOf([device('laptop').note({ text: 'x' })])));
  assert.ok(Object.isFrozen(getRegister(back, NOTE, 'text')));
});

test('a checkpoint carrying a prototype-polluting field name is refused', () => {
  const blob = serializeRegisters(foldOf([device('laptop').note({ text: 'x' })]));
  Object.defineProperty(blob.regs[NOTE], '__proto__', {
    value: { value: 1, stamp: stampAt(1), author: ME, op: 'q'.repeat(22) },
    enumerable: true, writable: true, configurable: true,
  });
  assert.throws(() => deserializeRegisters(blob), (e) => e instanceof RegisterError && /forbidden/.test(e.message));
});

// ═════════════════════════════════════════════════════════════════════════════
// J. Derived timestamps (ADR 001 §1.4)
// ═════════════════════════════════════════════════════════════════════════════

test('createdAt is the minimum stamp and updatedAt the maximum, over any fold order', () => {
  const mac = device('laptop');
  const born = mac.note({ text: 'a', _alive: true }, { born: true });
  mac.advance(50);
  const mid = mac.note({ date: '2026-09-10' });
  mac.advance(50);
  const last = mac.note({ text: 'b' });
  const rnd = mulberry32(21);
  for (let i = 0; i < 20; i++) {
    const regs = foldOf(shuffle(rnd, [born, mid, last]));
    assert.equal(createdAt(regs, NOTE), born.ts);
    assert.equal(createdAt(regs, NOTE), getValue(regs, NOTE, '_born'), 'createdAt IS the _born stamp');
    assert.equal(updatedAt(regs, NOTE), last.ts);
    assert.equal(updatedBy(regs, NOTE), ME);
  }
});

test('updatedBy names the member who wrote the newest register (17.6, "von Mama")', () => {
  const laptop = device('laptop');
  const mine = laptop.note({ text: 'Zahnarzt' }, { born: true });
  const mama = device('mama', { member: MAMA, short: SHORT.mama, startMs: 1787836800000 + 5000 });
  const hers = mama.emit('pub.set', FNOTE, { 'pub.text': 'Zahnarzt 15:00' });
  const regs = foldOf([mine, hers]);
  assert.equal(updatedBy(regs, NOTE), ME);
  assert.equal(updatedBy(regs, FNOTE), MAMA);
  assert.equal(updatedAt(regs, FNOTE), hers.ts);
});

test('the derived timestamps are null for an entity nobody wrote', () => {
  const regs = emptyRegisters();
  assert.equal(createdAt(regs, NOTE), null);
  assert.equal(updatedAt(regs, NOTE), null);
  assert.equal(updatedBy(regs, NOTE), null);
  assert.deepEqual(fieldNames(regs, NOTE), []);
  assert.equal(registersOf(regs, NOTE), undefined);
});

test('updatedBy is order-independent even when two registers tie on the stamp', () => {
  // Two ops at one stamp is not something an honest device produces; the map must still be a
  // function of the SET, so `updatedBy` falls through to the same `≺` the join uses.
  const s = stampAt(5000, 3);
  const a = op({ ts: s, id: 'a'.repeat(22), act: ME, f: { text: 'x' } });
  const b = op({ ts: s, id: 'b'.repeat(22), act: MAMA, f: { date: '2026-01-01' } });
  assert.equal(updatedBy(foldOf([a, b])), updatedBy(foldOf([b, a])));
  assert.equal(updatedBy(foldOf([a, b]), NOTE), MAMA, 'the greater opId breaks the tie, deterministically');
});

// ═════════════════════════════════════════════════════════════════════════════
// K. Housekeeping the rest of the core relies on
// ═════════════════════════════════════════════════════════════════════════════

test('foldAll mutates and returns the map it was given; fold() always starts fresh', () => {
  const mac = device('laptop');
  const regs = emptyRegisters();
  const same = foldAll(regs, [mac.note({ text: 'a' })]);
  assert.equal(same, regs, 'ops.contract.js §3 hands foldAll the map to fold into');
  const fresh = fold([mac.note({ text: 'b' })]);
  assert.notEqual(fresh, regs);
  assert.equal(registerCount(fresh), 1);
});

test('cloneRegisters isolates the copy without copying the frozen registers', () => {
  const mac = device('laptop');
  const regs = foldOf([mac.note({ text: 'a' })]);
  const copy = cloneRegisters(regs);
  assert.equal(sig(copy), sig(regs));
  assert.equal(getRegister(copy, NOTE, 'text'), getRegister(regs, NOTE, 'text'), 'shared, because frozen');
  mac.advance(10);
  applyOp(copy, mac.note({ text: 'b' }));
  assert.equal(getValue(regs, NOTE, 'text'), 'a', 'the original is untouched');
  assert.equal(getValue(copy, NOTE, 'text'), 'b');
});

test('entityKeys and fieldNames are sorted, so anything derived from them is deterministic', () => {
  const mac = device('laptop');
  const regs = foldOf([
    mac.emit('note.set', NOTE2, { text: 'z' }),
    mac.emit('cat.set', CAT, { visible: true, name: 'A', _alive: true }),
    mac.emit('note.set', NOTE, { text: 'a' }),
  ]);
  assert.deepEqual(entityKeys(regs), [CAT, NOTE, NOTE2].sort());
  assert.deepEqual(fieldNames(regs, CAT), ['_alive', 'name', 'visible']);
});

test('the join has no wall clock, no randomness and no I/O of its own', () => {
  // ADR 005 §2 is enforced mechanically by core-purity.test.js over the whole tree; this asserts
  // the consequence a caller cares about: the same ops fold to the same bytes, forever.
  const { ops } = trafficStream(12345);
  assert.equal(sig(foldOf(ops)), sig(foldOf(ops)));
  assert.equal(sig(foldOf(ops)), sig(foldOf(ops.slice().reverse())));
});
