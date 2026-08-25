// tests/attack/convergence-migrate.test.js
//
// CONVERGENCE ATTACKS on R12 — "is the migration byte-deterministic?" ADR 001 §8.1 property 2:
// "Two independent migrations of the same board.json are byte-identical", because otherwise
// Mac A migrates at T0 and edits at T1, Mac B migrates the same export at T2 > T1, and B's
// migration op writes the OLD text at a greater stamp.

import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateV1, GENESIS } from '../../src/js/core/migrate1to2.js';
import { fold } from '../../src/js/core/registers.js';
import { materialize } from '../../src/js/core/materialize.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { ME, MAMA } from '../helpers/gen.js';
import { DEV } from './_kit.js';

const CTX = { memberId: ME, deviceId: DEV.meDesk.id };

const board = () => ({
  schemaVersion: 1,
  categories: [
    { id: 'cat-a', name: 'Familie', nameEn: 'Family', paletteRef: 'p0', visible: true },
    { id: 'cat-b', name: 'Arbeit', nameEn: 'Work', paletteRef: 'p1', visible: true },
  ],
  notes: [
    { id: 'n1', date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-a', repeatsYearly: false },
    { id: 'n2', date: '2026-09-10', text: 'Yoga', categoryId: 'cat-b', repeatsYearly: false },
    { id: 'n3', date: '2026-09-10', text: 'Steuer', categoryId: 'cat-a', repeatsYearly: true },
  ],
  bars: [
    { id: 'b1', startDate: '2026-02-10', endDate: '2026-04-20', label: 'Projekt', categoryId: 'cat-a' },
  ],
  scratchpads: { '2026-03': 'Milch', '2026-04': 'Brot', '2026-05': 'Kaese' },
  // `startMonth` is REQUIRED alongside `mode: 'pinned'` — ATT-97: `materialize` refuses a pinned
  // board it cannot give `layout.js:25` a parseable month for, because the alternative is
  // `parseISO('null-01')` → `{y: NaN, m: NaN}` → an infinite loop in `holidays.js:51`. Added by
  // the ATT-97 fix (materialize.js), not by this file's owner; nothing else here changes.
  settings: { mode: 'pinned', startMonth: '2026-01', rowHeight: 30, layers: { feiertage: false, schulferien: true } },
});

const bytes = (r) => r.ops.map((o) => canonicalJSON(o)).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL — the same file migrates to the same bytes, twice, and entry KEY order is irrelevant.
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL — two migrations of the same board are byte-identical', () => {
  assert.equal(bytes(migrateV1(board(), CTX)), bytes(migrateV1(board(), CTX)));
});

test('CONTROL — the key order INSIDE an entry object does not change a single byte', () => {
  const b = board();
  const reorder = (o) => Object.fromEntries(Object.entries(o).reverse());
  const shuffledKeys = {
    ...b,
    categories: b.categories.map(reorder),
    notes: b.notes.map(reorder),
    bars: b.bars.map(reorder),
    settings: Object.fromEntries(Object.entries(b.settings).reverse()),
  };
  assert.equal(bytes(migrateV1(shuffledKeys, CTX)), bytes(migrateV1(b, CTX)));
});

test('CONTROL — GENESIS indices are one global ascending counter in v1 array order', () => {
  const r = migrateV1(board(), CTX);
  const contentOps = r.ops.filter((o) => o.k !== 'pref.set');
  contentOps.forEach((o, i) => assert.equal(o.ts, GENESIS(i), `op ${i} (${o.e})`));
  const board2 = materialize(fold(r.ops), { me: ME, familySpaceId: null });
  assert.deepEqual(board2.notes.map((n) => n.id), ['n1', 'n2', 'n3'], 'v1 insertion order survives the sort');
  assert.deepEqual(board2.categories.map((c) => c.id), ['cat-a', 'cat-b']);
});

// ─────────────────────────────────────────────────────────────────────────────
// M1 — CLOSED. The scratchpad object's KEY ORDER no longer reaches the ops.
//
// It used to: `migrate1to2` walked `Object.keys(v1board.scratchpads)`, i.e. the parsed JSON's
// own order, and that order fed the global index counter — so two boards holding the SAME pads
// written in a different order migrated to different `_born` stamps and different derived
// opIds, and ADR 001 §8.1 property 2 was false for any board that had been through an editor, a
// re-export or any other whole-file rewrite. The settings patch a few lines below was already
// sorted for exactly this reason; the fix is the same one line, on the pads.
// ─────────────────────────────────────────────────────────────────────────────

test('M1 CLOSED — reordering the scratchpads object changes not one byte', () => {
  const a = board();
  const b = board();
  b.scratchpads = { '2026-05': 'Kaese', '2026-03': 'Milch', '2026-04': 'Brot' };

  const ra = migrateV1(a, CTX);
  const rb = migrateV1(b, CTX);

  // Same pads, same values, same everything a human can see…
  assert.deepEqual(
    Object.fromEntries(Object.entries(a.scratchpads).sort()),
    Object.fromEntries(Object.entries(b.scratchpads).sort()),
  );
  // …and now the same bytes, which is what §8.1 property 2 actually asks for.
  assert.equal(bytes(ra), bytes(rb));
  const padBorn = (r) => Object.fromEntries(
    r.ops.filter((o) => o.k === 'pad.set').map((o) => [o.e, o.f._born]),
  );
  assert.deepEqual(padBorn(ra), padBorn(rb));
  assert.deepEqual(ra.ops.filter((o) => o.k === 'pad.set').map((o) => o.e),
    ['pad:2026-03', 'pad:2026-04', 'pad:2026-05'], 'the counter walks the keys in sorted order');

  const mctx = { me: ME, familySpaceId: null };
  assert.equal(
    JSON.stringify(materialize(fold(ra.ops), mctx)),
    JSON.stringify(materialize(fold(rb.ops), mctx)),
  );
});

test('M1 CLOSED — every permutation of the same pads migrates to the same bytes', () => {
  const keys = ['2026-01', '2026-03', '2026-04', '2026-05', '2026-12'];
  const perm = (k, i) => k.map((_, n) => k[(n + i) % k.length]);
  const gold = bytes(migrateV1({ ...board(), scratchpads: Object.fromEntries(keys.map((k) => [k, `t${k}`])) }, CTX));
  for (let i = 1; i < keys.length; i++) {
    const order = perm(keys, i);
    const pads = Object.fromEntries(order.map((k) => [k, `t${k}`]));
    assert.equal(bytes(migrateV1({ ...board(), scratchpads: pads }, CTX)), gold, order.join(','));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// M2 — CLOSED. The opId is a function of the FILE, not of who is holding it.
//
// It used to be derived from `(label, act, index, kind, entityKey)`, on the reasoning that mixing
// in the acting member stops two members migrating the same shared export from colliding. That
// reasoning does not survive contact with solo mode: there is no minted MemberId (§11), so my two
// Macs hold different placeholders until they pair, and "two independent migrations of the same
// board.json are BYTE-IDENTICAL" was therefore false for the configuration the product ships in.
// The symptom was not a crash — the stamps still agreed, so the values still converged — but
// every migrated register was attributed to whichever member id won an opId tiebreak, and 17.6's
// „geändert von Mama" line then named the wrong person on the user's own eleven-year-old notes.
//
// The collision it was avoiding is not a hazard: migration ops go to the PERSONAL space, so two
// different people's migrations never meet. Between my own two Macs a collision is the POINT —
// `opId` is the server's idempotency key.
// ─────────────────────────────────────────────────────────────────────────────

test('M2 CLOSED — two Macs with DIFFERENT memberIds migrate the same file to the same ops', () => {
  const macA = migrateV1(board(), { memberId: ME, deviceId: DEV.meDesk.id });
  const macB = migrateV1(board(), { memberId: MAMA, deviceId: DEV.meLap.id });

  assert.deepEqual(macA.ops.map((o) => o.ts), macB.ops.map((o) => o.ts), 'stamps agree (§8.1 property 1)');
  assert.deepEqual(macB.ops.map((o) => o.id), macA.ops.map((o) => o.id), 'and so do the op ids');
  for (let i = 0; i < macA.ops.length; i++) {
    const { act: a1, dev: d1, ...restA } = macA.ops[i];
    const { act: a2, dev: d2, ...restB } = macB.ops[i];
    assert.deepEqual(restB, restA, `op ${i} (${macA.ops[i].e}) differs beyond act/dev`);
  }

  // Pairing the two Macs: one author, because one op id means one op — the second Mac's push is
  // deduplicated by the relay instead of stored twice.
  const merged = fold([...macA.ops, ...macB.ops]);
  const authors = new Set();
  for (const cells of merged.values()) for (const r of cells.values()) authors.add(r.author);
  assert.equal(authors.size, 1, 'one author, decided by the fold’s value tiebreak and not by luck');
  assert.equal(
    JSON.stringify([...fold([...macB.ops, ...macA.ops]).keys()].sort()),
    JSON.stringify([...merged.keys()].sort()),
    'the join is still order-independent',
  );

  const mctx = { me: ME, familySpaceId: null };
  const paired = materialize(merged, mctx);
  const soloA = materialize(fold(macA.ops), mctx);
  assert.equal(JSON.stringify(paired), JSON.stringify(soloA),
    'pairing changes NOTHING — including 17.6’s „geändert von" attribution');
  assert.equal(new Set(paired.notes.map((n) => n.updatedBy)).size, 1);
});

test('M2 CLOSED — neither ctx.memberId nor ctx.deviceId reaches a single op id', () => {
  const ids = (ctx) => migrateV1(board(), ctx).ops.map((o) => o.id);
  const base = ids({ memberId: ME, deviceId: DEV.meDesk.id });
  for (const ctx of [
    { memberId: MAMA, deviceId: DEV.meDesk.id },
    { memberId: ME, deviceId: DEV.meLap.id },
    { memberId: MAMA, deviceId: DEV.meLap.id },
  ]) assert.deepEqual(ids(ctx), base, JSON.stringify(ctx));
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL — every migrated field loses to every future edit on every device (§8.1 property 1).
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL — a migrated field loses to any later write, at any wall clock', () => {
  const r = migrateV1(board(), CTX);
  for (const op of r.ops) assert.ok(op.ts.startsWith('0000000000000.'), `${op.e} was stamped ${op.ts}`);
});
