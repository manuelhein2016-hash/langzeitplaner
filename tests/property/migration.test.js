// tests/property/migration.test.js — P8, migration losslessness and byte-identity (LZP-406).
//
// Two properties, and they protect two different disasters.
//
// **P8 (losslessness).** `materialize(foldAuthorized(migrateV1(b).ops))` deep-equals
// `stripV2Fields(v1migrate(b))`, array order included. The disaster it prevents is the obvious
// one: the upgrade runs once, on the user's only copy of eleven years of appointments, and if it
// drops a field there is nothing to compare against afterwards.
//
// **P8/R12 (byte-identity).** Two INDEPENDENT migrations of the same `board.json` produce
// byte-identical ops. The disaster it prevents is much less obvious and much worse. The user has
// two Macs. Both upgrade. Both migrate their own copy of the same file. Then they pair. If the
// two migrations produced different opIds or different stamps, every entry now exists TWICE in
// the merged log with no way to tell that they are the same entry — and the "fix" a naive
// implementation reaches for (last-writer-wins across the two) silently discards whichever Mac
// migrated first, along with any edit made on it since. ADR 001 §8.1 exists for this.
//
// Byte-identity is why migration cannot use `crypto.randomUUID()` for opIds and cannot read the
// clock for stamps — and why the ops it emits carry a DERIVED opId and a `GENESIS(index)` stamp.
// These tests are what stop someone "simplifying" that back to the normal minting path.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { generateBoard, pcg32, shuffle, duplicateSome, partition } from '../helpers/gen.js';
import { SEEDS, seeds, forEachSeed, sig } from './harness.js';

import { defaultState } from '../../src/js/store.js';
import { buildBoard } from '../../src/js/layout.js';
import { migrateV1, GENESIS, MAX_GENESIS_INDEX } from '../../src/js/core/migrate1to2.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import { fold, mergeMaps, serializeRegisters } from '../../src/js/core/registers.js';
import { materialize, stripV2Fields } from '../../src/js/core/materialize.js';
import { sortScratchpads } from '../../src/js/core/entities.js';

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('ME')}`;
const DEV_A = `dev_${pad22('MACA')}`;
const DEV_B = `dev_${pad22('MACB')}`;

const board = (seed) => generateBoard(seed, { defaults: defaultState() });

const MCTX = {
  me: ME, familySpaceId: null, members: new Map(), currentMembers: new Set([ME]),
  hiddenMembers: new Set(), prefs: {}, lastSeenSeq: {}, defaultSettings: defaultState().settings,
};

/** The whole pipeline: v1 board → ops → authorized fold → v1 state shape. */
function roundTrip(b, ops) {
  const r = foldAuthorized(ops ?? migrateV1(b, { memberId: ME, deviceId: DEV_A }).ops,
    { me: ME, nowMs: Date.parse('2026-08-25T00:00:00Z'), attestVerify: () => false });
  assert.equal(r.rejected.length, 0, 'a migration op was refused by the authorization fold');
  assert.equal(r.parked.length, 0, 'a migration op was parked');
  return materialize(r.regs, MCTX);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P8 — losslessness
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P8 — materialize(fold(migrateV1(b))) deep-equals the v1 board, over ${SEEDS} seeds`, () => {
  forEachSeed(seeds(), 'P8 losslessness', (seed) => {
    const b = board(seed);
    const out = stripV2Fields(roundTrip(b));

    // ADR 001 §8.3's AC reads "including array order after the deterministic sort", and it means
    // it: notes, bars and categories all keep v1's ARRAY order — that is exactly what the GENESIS
    // index buys, and the corpus is built with descending ids so uuid order cannot accidentally
    // supply it. Only `scratchpads` is re-keyed, and that is a sorted OBJECT, not an array.
    //
    // ATT-50 / ATT-52: bars used to be excepted here, compared against `sortBars(b.bars)` because
    // `cmpBars` re-sorted them by `(startDate asc, endDate desc, id asc)`. That made the AC false
    // for any board whose bars were not already in date order, which is most of them. `cmpBars`
    // is now `(_born asc, id asc)` like the other two, and the exception is gone with it.
    assert.deepEqual(out.notes, b.notes, 'notes lost their v1 array order or a field');
    assert.deepEqual(out.categories, b.categories, 'categories lost their v1 array order or a field');
    assert.deepEqual(out.bars, b.bars, 'bars lost their v1 array order or a field');
    assert.deepEqual(out.scratchpads, sortScratchpads(b.scratchpads), 'scratchpads differ');
    assert.deepEqual(out.settings, b.settings, 'a setting was lost or fabricated');
  });
});

test('P8 — the migrated board renders identically through the REAL layout.js', () => {
  // Deep-equal arrays do not prove the board LOOKS the same: `layout.js` slices to capacity
  // (:209) and rescues lanes per column (:162-177), both order-sensitive. Running the real layout
  // over both is the only assertion that covers what the user actually sees.
  //
  // The expectation is v1's board EXACTLY AS STORED. It used to be v1's board with its bars put
  // through `sortBars` — a fudge that looked principled because ADR 001 §5 step 5 sanctioned the
  // re-sort, and that hid ATT-50/ATT-52: the re-sort moved `seg.labelRow` on real boards. With
  // `cmpBars` on `(_born asc, id asc)` there is nothing left to except, so the comparison is now
  // against the user's own file and the test can fail for the reason it was written for.
  forEachSeed(seeds(200), 'P8 through layout.js', (seed) => {
    const b = board(seed);
    const expected = buildBoard(b);
    const actual = buildBoard(stripV2Fields(roundTrip(b)));
    assert.equal(actual.cols.length, expected.cols.length);
    for (let i = 0; i < expected.cols.length; i++) {
      assert.deepEqual(actual.cols[i].days, expected.cols[i].days,
        `column ${expected.cols[i].key}: day rows differ`);
      assert.deepEqual(actual.cols[i].segs, expected.cols[i].segs,
        `column ${expected.cols[i].key}: segments differ`);
    }
  });
});

test('P8 — CLOSED (ATT-50/ATT-52): migration moves NOTHING on the rendered board', () => {
  // This test used to CHARACTERIZE a defect. It asserted that migrating a board whose `bars`
  // array was not already in `(startDate asc, endDate desc, id asc)` order changed `seg.labelRow`
  // — which row inside a multi-row bar the label is drawn on — and it required at least one board
  // in the corpus to demonstrate that, so the "deliberate reordering" could not be forgotten.
  //
  // It is no longer a characterization, because the reordering is gone: `cmpBars` is `(_born asc,
  // id asc)`, so a migrated board's arrays are the user's own file order and `buildBoard` over
  // the two boards agrees COLUMN FOR COLUMN — days, segments, lanes and label rows alike.
  //
  // The corpus deliberately contains boards whose bars are NOT in date order; the counter below
  // proves it, so a version of this test that could not have caught the old behaviour cannot
  // pass silently.
  let boardsWithUnsortedBars = 0;
  forEachSeed(seeds(200), 'P8 render identity', (seed) => {
    const b = board(seed);
    const dateOrder = [...b.bars].sort((x, y) =>
      (x.startDate < y.startDate ? -1 : x.startDate > y.startDate ? 1 : 0) ||
      (y.endDate < x.endDate ? -1 : y.endDate > x.endDate ? 1 : 0) ||
      (x.id < y.id ? -1 : 1));
    if (sig(dateOrder.map((x) => x.id)) !== sig(b.bars.map((x) => x.id))) boardsWithUnsortedBars++;

    const asStored = buildBoard(b);
    const migrated = buildBoard(stripV2Fields(roundTrip(b)));
    for (let i = 0; i < asStored.cols.length; i++) {
      assert.deepEqual(migrated.cols[i].days, asStored.cols[i].days,
        `column ${asStored.cols[i].key}: migration moved a NOTE`);
      assert.deepEqual(migrated.cols[i].segs, asStored.cols[i].segs,
        `column ${asStored.cols[i].key}: migration moved a BAR SEGMENT`);
    }
  });
  assert.ok(boardsWithUnsortedBars > 0,
    'no board in the corpus has bars out of date order — this test could not have caught ATT-52');
});

test('P8 — migration is lossless under adversarial DELIVERY, not just in order', () => {
  // A migration is pushed to the server and pulled by the other Mac, so its ops arrive shuffled
  // and sometimes twice. Losslessness has to survive that, or the second Mac renders a different
  // board from the first.
  forEachSeed(seeds(250), 'P8 under shuffle/duplication', (seed) => {
    const b = board(seed);
    const { ops } = migrateV1(b, { memberId: ME, deviceId: DEV_A });
    const rnd = pcg32(seed ^ 0x88);
    const target = sig(stripV2Fields(roundTrip(b, ops)));
    for (let i = 0; i < 6; i++) {
      const delivered = duplicateSome(rnd, shuffle(rnd, ops), 0.25);
      assert.equal(sig(stripV2Fields(roundTrip(b, delivered))), target, `delivery ${i} differed`);
    }
    // …and split across a partition, folded as register maps and merged.
    const parts = partition(rnd, ops, 3);
    const merged = parts.map((p) => fold(p)).reduce((acc, m) => mergeMaps(acc, m));
    assert.equal(sig(stripV2Fields(materialize(merged, MCTX))), target, 'a partitioned migration differed');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P8 / R12 — byte-identity across two independent migrations
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P8/R12 — migrating one board twice is byte-identical, over ${SEEDS} seeds`, () => {
  forEachSeed(seeds(), 'P8/R12 byte-identity', (seed) => {
    const b = board(seed);
    const a = migrateV1(b, { memberId: ME, deviceId: DEV_A });
    const c = migrateV1(b, { memberId: ME, deviceId: DEV_A });
    assert.equal(sig(a.ops), sig(c.ops), 'two migrations of the same board differed');
    assert.equal(sig(a.warnings), sig(c.warnings));
  });
});

test(`P8/R12 — TWO MACS migrate identically: only op.dev may differ, over ${SEEDS} seeds`, () => {
  // The property the whole GENESIS design exists for. Everything that participates in merge —
  // the opId, the stamp, the entity key, the field patch — must be identical on both machines.
  // `op.dev` is provenance, not merge input, and is the one permitted difference.
  forEachSeed(seeds(), 'P8/R12 two Macs', (seed) => {
    const b = board(seed);
    const macA = migrateV1(b, { memberId: ME, deviceId: DEV_A }).ops;
    const macB = migrateV1(b, { memberId: ME, deviceId: DEV_B }).ops;

    assert.equal(macA.length, macB.length);
    for (let i = 0; i < macA.length; i++) {
      const { dev: devA, ...restA } = macA[i];
      const { dev: devB, ...restB } = macB[i];
      assert.equal(devA, DEV_A);
      assert.equal(devB, DEV_B);
      assert.deepEqual(restB, restA, `op ${i} differs between the two Macs beyond op.dev`);
    }

    // …so the merged log deduplicates instead of doubling, and the board is unchanged.
    const merged = fold([...macA, ...macB]);
    assert.equal(sig(serializeRegisters(merged)), sig(serializeRegisters(fold(macA))),
      'merging two migrations of one board changed the state');
  });
});

test('P8/R12 — the opId excludes op.dev AND the payload, both for reasons', () => {
  // Excluding `op.dev`: otherwise the two Macs derive different ids and R12 fails outright.
  // Excluding `f`: the opId is SERVER-VISIBLE (ADR 003), so hashing the payload into it would
  // hand the relay a confirmation oracle — guess "Zahnarzt", hash it, look for the id — which
  // defeats the point of encrypting the body at all. Both are asserted because a future
  // "improvement" that made the id content-addressed would look like a good idea.
  forEachSeed(seeds(150), 'P8/R12 opId derivation', (seed) => {
    const b = board(seed);
    if (!b.notes.length) return;
    const base = migrateV1(b, { memberId: ME, deviceId: DEV_A }).ops;
    const other = migrateV1(b, { memberId: ME, deviceId: DEV_B }).ops;
    assert.deepEqual(other.map((o) => o.id), base.map((o) => o.id), 'the opId depends on op.dev');

    // Change one note's TEXT only. The op ids must not move — they name a position in the
    // migration, not its content.
    const edited = { ...b, notes: b.notes.map((n, i) => (i === 0 ? { ...n, text: `${n.text}!` } : n)) };
    const after = migrateV1(edited, { memberId: ME, deviceId: DEV_A }).ops;
    assert.deepEqual(after.map((o) => o.id), base.map((o) => o.id),
      'the opId is derived from the payload — that is a confirmation oracle on the relay');
    assert.notEqual(sig(after), sig(base), 'the edit did not reach the ops at all');
  });
});

test('P8/R12 — a JSON round trip and key reordering of the input change nothing', () => {
  // `board.json` is human-readable (11.4) and a user may have opened it in an editor. Key order
  // in the file must not reach the ops.
  forEachSeed(seeds(200), 'P8/R12 input normalisation', (seed) => {
    const b = board(seed);
    const base = migrateV1(b, { memberId: ME, deviceId: DEV_A }).ops;
    const roundTripped = JSON.parse(JSON.stringify(b));
    assert.equal(sig(migrateV1(roundTripped, { memberId: ME, deviceId: DEV_A }).ops), sig(base));

    // Rebuild every note object with its keys in reverse order.
    const flipped = {
      ...b,
      notes: b.notes.map((n) => Object.fromEntries(Object.entries(n).reverse())),
    };
    assert.equal(sig(migrateV1(flipped, { memberId: ME, deviceId: DEV_A }).ops), sig(base),
      'the input\'s key order reached the emitted ops');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The GENESIS stamp itself
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('P8 — every migrated op loses to every future edit, and carries its own array index', () => {
  // ADR 001 §8.1: migration stamps sort below everything, so a real edit made at wall-millisecond
  // 1 beats the highest possible GENESIS index. Without that, a second Mac's later migration
  // could out-rank the first Mac's edits — the silent data-loss path §8.1 was written to close.
  forEachSeed(seeds(200), 'P8 GENESIS ordering', (seed) => {
    const b = board(seed);
    const { ops } = migrateV1(b, { memberId: ME, deviceId: DEV_A });
    const top = GENESIS(MAX_GENESIS_INDEX);
    for (const op of ops) {
      assert.ok(op.ts <= top, `a migration stamp sorted above GENESIS(MAX): ${op.ts}`);
    }
    // The indices are distinct and ascending — that is what preserves v1's array order.
    const stamps = ops.map((o) => o.ts);
    const sorted = stamps.slice().sort();
    assert.deepEqual(stamps, sorted, 'the migration emitted its ops out of stamp order');
    assert.equal(new Set(stamps).size, stamps.length, 'two migration ops share a stamp');
  });
});

test('P8 — a real edit at wall-millisecond 1 beats the highest possible GENESIS stamp', () => {
  const top = GENESIS(MAX_GENESIS_INDEX);
  // A stamp is pad13(ms).pad6(ctr).deviceShort16, so plain string order is the comparator.
  const realEdit = `${String(1).padStart(13, '0')}.${'0'.repeat(6)}.${'0'.repeat(16)}`;
  assert.ok(realEdit > top,
    'a migrated field would beat a genuine edit — ADR 001 §8.1\'s data-loss path is open');
});
