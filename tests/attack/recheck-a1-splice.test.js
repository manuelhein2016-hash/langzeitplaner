// tests/attack/recheck-a1-splice.test.js
//
// SECOND ADVERSARY PASS against the A1 fix (envelope splicing resolved content-addressably).
//
// The comparator itself holds: three-way splices converge under every arrival order, and a
// malformed body neither wins nor disturbs the contest. Those are `CONTROL` tests below and they
// are the part of the fix that is real.
//
// The hole was the interaction with §7.2. `append()`'s docblock called the post-compaction case
// "ONE RESIDUAL LIMIT" and framed it as a REPORTING limit — "a second body arriving afterwards
// is indistinguishable from an honest duplicate and is reported as one". It was not a reporting
// limit. It was a permanent divergence of REGISTER VALUES between two devices holding an identical
// op set, and the only variable was whether a device happened to compact between the two
// envelopes. §7.2 exists so that compaction is invisible to state; there it decided state.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// CLOSED IN ROUND 2, and the tests below are INVERTED: each one now asserts the convergence it
// used to assert the absence of. Two changes, and they are inseparable:
//
//   1. `checkpoint().bodies` — one 96-bit `bodyFingerprint` per opId whose line has been absorbed.
//      Dedupe-by-opId is only sound for a REPEATED body; the fingerprint is what tells a repeat
//      from a second body once the first has been compacted, so `seen.has(id)` can no longer
//      answer `duplicate` to a splice.
//   2. The resolution itself is now the REGISTER JOIN. Every admitted body is folded and `≺`
//      (stamp, opId, value) decides field by field; nothing is ever un-applied. This is forced,
//      not chosen: a resolution that un-applies the loser cannot survive its own compaction,
//      because the value the loser displaced is gone from the checkpoint for ever, so no bounded
//      amount of retained metadata can restore it. The only resolution that is stable under
//      compaction is one that is MONOTONE with respect to the fold — and compaction is nothing
//      but partial evaluation of that same fold. The canonical max still keeps the LINE, so the
//      plaintext this log retains and reports is the same on every device (`kept:`), and
//      `authz.js` still picks its body by the identical comparator.
//
// What is given up is that the losing body's fields no longer vanish; RECHECK-A1-8 pins that
// explicitly so nobody "fixes" it back. What is bought is that all 3 orderings × 4 compaction
// points below agree, which is what ADR 001 §0.2 requires and what §12.2 does not make optional.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpLog } from '../../src/js/core/oplog.js';
import { noteKey } from '../../src/js/core/entities.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { BASE_MS, DAY, DEV, PSP, minter, pad22, regsJSON, shuffled } from './_kit.js';

const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = BASE_MS + 400 * DAY;
const mk = () => createOpLog({ now: () => NOW });
const me = minter(DEV.meDesk);

/** One opId, three different bodies — the ADR 002 §5.1 shape. */
const base = me('note.set', noteKey(U), { text: 'aaa' }, { ms: BASE_MS, space: PSP, id: pad22('SPLICED') });
const body = (text) => Object.freeze({ ...base, f: Object.freeze({ text }) });
const LOW = body('aaa');
const MID = body('mmm');
const HIGH = body('zzz');

const textOf = (log) => log.registers().get(noteKey(U))?.get('text')?.value ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A1-1 — CLOSED. Two honest devices, one op set, one board.
//
// Device A pulled the first envelope, ran its ordinary §7.2 compaction that night, and pulled the
// second envelope the next morning. Device B pulled both before it compacted. Neither device did
// anything unusual — §7.2's stated policy is a 30-day tail, so any splice whose two envelopes are
// separated by a compaction lands here, and a splice is by definition two envelopes that did not
// arrive together.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A1-1 — CLOSED: a compaction between the two envelopes changes nothing', () => {
  const a = mk();
  a.append(LOW);
  a.compact();                                     // the ordinary §7.2 tail trim
  const second = a.append(HIGH);

  const b = mk();
  b.append(LOW);
  b.append(HIGH);

  assert.equal(second.status, 'conflict',
    'the second body is recognised as a splice, not answered DUPLICATE, after compaction');
  assert.equal(textOf(a), 'zzz');
  assert.equal(textOf(b), 'zzz', 'non-vacuity: without the compaction the comparator picks the max');
  assert.equal(regsJSON(a.registers()), regsJSON(b.registers()),
    'two devices, one op set, different registers — decided by a compaction that §7.2 promises '
    + 'is invisible to state');

  // …and the compacted device KNOWS a splice happened, which is the ADR 002 §5.1 tamper evidence.
  assert.deepEqual(a.splicedIds(), [base.id], 'device A does not even know a splice happened');
  assert.deepEqual(b.splicedIds(), [base.id]);
});

test('RECHECK-A1-2 — CLOSED: re-delivering the whole op set is a no-op, from either side', () => {
  const a = mk();
  a.append(LOW);
  a.compact();
  a.append(HIGH);
  const settled = regsJSON(a.registers());
  for (const o of [LOW, HIGH, LOW, HIGH]) a.append(o);
  assert.equal(textOf(a), 'zzz', 'the canonical max stands under any amount of re-delivery');
  assert.equal(regsJSON(a.registers()), settled, 'a re-delivery moved the registers');
  assert.deepEqual(a.splicedIds(), [base.id], 'and the report is a function of the SET');
});

test('RECHECK-A1-3 — CLOSED: the resolution survives the documented persist pair', () => {
  const a = mk();
  a.append(LOW);
  a.compact();
  a.append(HIGH);
  const relaunched = mk();
  relaunched.load(JSON.parse(JSON.stringify({ checkpoint: a.checkpoint(), tail: a.ops() })));
  assert.equal(textOf(relaunched), 'zzz', 'the wrong body is now baked into the checkpoint on disk');
  assert.deepEqual(relaunched.splicedIds(), [base.id],
    'and the tamper evidence survives the relaunch too (REG-28)');
  assert.equal(relaunched.append(LOW).status, 'conflict',
    'the losing body re-delivered after a relaunch is still recognised as the splice it is');
  assert.equal(textOf(relaunched), 'zzz');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A1-1b — THE FULL GRID the fix has to satisfy: every arrival order of every subset
// × every point at which a compaction could land. One register value, or the fix is not a fix.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A1-1b — CLOSED: 3 orderings × 4 compaction points converge on one register', () => {
  const orders = [[LOW, MID, HIGH], [MID, HIGH, LOW], [HIGH, LOW, MID]];
  const seen = new Set();
  const shapes = [];
  for (const order of orders) {
    for (let cut = 0; cut <= 3; cut++) {             // compact before / after 1 / after 2 / after 3
      const log = mk();
      for (let i = 0; i < order.length; i++) {
        if (cut === i) log.compact();
        log.append(order[i]);
      }
      if (cut === 3) log.compact();
      seen.add(regsJSON(log.registers()));
      shapes.push(`${order.map((o) => o.f.text).join('>')} @${cut}`);
    }
  }
  assert.equal(seen.size, 1, `the grid forked: ${shapes.join(', ')}`);
  const winner = mk();
  winner.append(HIGH);
  assert.equal([...seen][0], regsJSON(winner.registers()),
    'and they agree on the canonical MAX, not on an arrival order or a compaction point');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A1-8 — THE PRICE, pinned so it cannot be "fixed" back. The losing body's writes are
// ABSORBED, not un-applied: a field only the loser wrote survives. That is the whole reason the
// resolution now survives compaction, because un-applying is exactly what a checkpoint cannot do.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A1-8 — the loser is absorbed, never un-applied, and that too is compaction-stable', () => {
  const withDate = Object.freeze({ ...base, f: Object.freeze({ text: 'aaa', date: '2026-09-10' }) });
  assert.ok(canonicalJSON(HIGH) > canonicalJSON(withDate), 'non-vacuity: HIGH is still the max');

  const variants = [];
  for (const order of [[withDate, HIGH], [HIGH, withDate]]) {
    for (let cut = 0; cut <= 2; cut++) {
      const log = mk();
      for (let i = 0; i < order.length; i++) {
        if (cut === i) log.compact();
        log.append(order[i]);
      }
      if (cut === 2) log.compact();
      variants.push(regsJSON(log.registers()));
    }
  }
  assert.equal(new Set(variants).size, 1, 'the disjoint-field splice forks under order or compaction');

  const one = mk();
  one.append(withDate);
  one.append(HIGH);
  assert.equal(textOf(one), 'zzz', 'the canonical max wins the field both bodies write');
  assert.equal(one.registers().get(noteKey(U)).get('date').value, '2026-09-10',
    "the loser's own field is absorbed — un-applying it is what could not survive §7.2");
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A1-4 — CONTROL. The comparator itself is sound: THREE bodies, every arrival order,
// same winner. The fix holds here and this test says so.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A1-4 — CONTROL: a three-way splice converges under every arrival order', () => {
  const orders = [
    [LOW, MID, HIGH], [LOW, HIGH, MID], [MID, LOW, HIGH],
    [MID, HIGH, LOW], [HIGH, LOW, MID], [HIGH, MID, LOW],
  ];
  const seen = new Set();
  for (const order of orders) {
    const log = mk();
    for (const o of order) log.append(o);
    seen.add(regsJSON(log.registers()));
  }
  assert.equal(seen.size, 1, 'all six orders agree');
  const winner = mk();
  winner.append(HIGH);
  assert.equal([...seen][0], regsJSON(winner.registers()),
    'and they agree on the canonical MAX, not on the first or last arrival');
  // Non-vacuity: the three bodies really are three different canonical forms.
  assert.equal(new Set([LOW, MID, HIGH].map(canonicalJSON)).size, 3);
});

test('RECHECK-A1-5 — CONTROL: bodies that canonicalize equal are a duplicate, not a splice', () => {
  const log = mk();
  log.append(base);
  // Same fields, different JS key insertion order — canonicalJSON must not see a difference.
  const reordered = Object.freeze({
    f: base.f, e: base.e, k: base.k, gid: base.gid, dev: base.dev,
    act: base.act, space: base.space, ts: base.ts, id: base.id, v: base.v,
  });
  assert.equal(canonicalJSON(reordered), canonicalJSON(base), 'non-vacuity: they canonicalize equal');
  assert.equal(log.append(reordered).status, 'duplicate');
  assert.deepEqual(log.splicedIds(), [], 'no phantom splice is reported');
});

test('RECHECK-A1-6 — CONTROL: a malformed body neither wins the splice nor disturbs it', () => {
  const log = mk();
  log.append(LOW);
  // A body that sorts ABOVE `zzz` but breaks a declared type. Classification runs first.
  const junk = Object.freeze({ ...base, f: Object.freeze({ text: 12345 }) });
  assert.equal(log.append(junk).status, 'rejected');
  assert.equal(textOf(log), 'aaa', 'the standing body is untouched');
  assert.deepEqual(log.splicedIds(), [], 'and the malformed body did not even mark the id spliced');
  assert.equal(log.append(HIGH).status, 'conflict');
  assert.equal(textOf(log), 'zzz', 'a well-formed higher body still wins afterwards');
});

test('RECHECK-A1-7 — CONTROL: permutations of an honest op set still fold identically', () => {
  const ops = [
    me('note.set', noteKey(U), { date: '2026-09-10' }, { ms: BASE_MS + 1, space: PSP, id: pad22('P1') }),
    me('note.set', noteKey(U), { text: 'b' }, { ms: BASE_MS + 2, space: PSP, id: pad22('P2') }),
    me('note.set', noteKey(U), { text: 'c' }, { ms: BASE_MS + 3, space: PSP, id: pad22('P3') }),
    LOW, HIGH,
  ];
  const folds = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const log = mk();
    for (const o of shuffled(ops, seed)) log.append(o);
    folds.add(regsJSON(log.registers()));
  }
  assert.equal(folds.size, 1, 'the fold is a function of the op SET (ADR 001 §0.2)');
});
