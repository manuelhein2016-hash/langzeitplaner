// tests/attack/recheck-a7-tombstone.test.js
//
// SECOND ADVERSARY PASS against the A7 fix (tombstone GC vs unpushed writes).
//
// `tombstoneCollectable` is now hard to fool from the OUTSIDE: it refuses to guess, it demands
// `minPushedSeq` as well as `minDeviceSeq`, and it refuses any entity with an unacked stamp on
// ANY register. Those tests are `CONTROL` below and they hold.
//
// The hole was one layer down, in the thing condition 3 is evaluated AGAINST. `seqOf` was backed
// by `seqByStamp` — a map keyed by STAMP, not by opId — and `admit()` overwrote the entry whenever
// the incoming op carried a seq. A stamp is only unique per (device, ms, ctr), which the local
// clock guarantees for OUR OWN ops and guarantees for nobody else's. One well-formed op carrying
// a duplicate stamp therefore rewrote the server seq that GC reads for an unrelated entity, and
// it could rewrite it DOWNWARD — the unsafe direction: it collected a tombstone hundreds of seqs
// before every device had read past it, which is R15 through the front door.
//
// This defeated D7 as stated. The op is well-formed, every device accepts it, and every device
// folds it identically — so it is not "an op the others will reject".
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// CLOSED IN ROUND 2. The tests below are INVERTED. Three changes:
//
//   · the seq index is keyed by OPID (`seqOfOp`), which identifies exactly one op, and
//     `checkpoint().seqs` is keyed by opId too. A pre-A7, stamp-keyed checkpoint still loads —
//     the two key shapes are distinguishable, so no migration pass and no version flag.
//   · a seq is only ever RAISED. `seqOf(stamp)` survives as the compatibility view and reports
//     the MAXIMUM over every op sharing the stamp; over-reporting can only refuse a collection,
//     never permit one early.
//   · `collectTombstones` no longer deletes an unpushed live line (A7-b). An entity we still
//     hold an unacked line for is simply NOT collectable — which is §7.3 condition 3(b) applied
//     to the case the register-side guard cannot see, because a write that LOST the join to the
//     tombstone leaves no register behind to check.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpLog, tombstoneCollectable, TOMBSTONE_MIN_AGE_MS, ZERO_STAMP } from '../../src/js/core/oplog.js';
import { noteKey } from '../../src/js/core/entities.js';
import { DEV, PSP, minter, pad22 } from './_kit.js';

const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const V = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD = 1000;                                    // the tombstone's wall clock
const NOW = OLD + TOMBSTONE_MIN_AGE_MS + 10 * 86400000;
const mk = () => createOpLog({ now: () => NOW });
const mama = minter(DEV.mama);
const me = minter(DEV.meDesk);

/** MAMA deletes a note. Every register of the entity is written by this one ancient op. */
const tombstone = (id = 'TOMB') => mama('note.set', noteKey(U),
  { date: '2020-01-01', text: 'weg', categoryId: 'cat-1', repeatsYearly: false, _alive: false, _born: ZERO_STAMP },
  { ms: OLD, ctr: 5, space: PSP, id: pad22(id) });

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A7-1 — CLOSED. A stamp collision cannot move the seq the GC rule is evaluated against.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A7-1 — CLOSED: a duplicate-stamp op cannot collapse the GC seq', () => {
  const log = mk();
  const tomb = tombstone();
  log.append(tomb, { seq: 900 });                    // the relay really stored the delete at 900

  // Non-vacuity: with the truth intact, GC correctly refuses — no device has read past 900.
  assert.equal(log.seqOf(tomb.ts), 900n);
  assert.equal(log.seqOfOp(tomb.id), 900n);
  assert.deepEqual(log.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }), [],
    'pre-condition: condition 3 blocks collection at minSeq 20');

  // ZORRO patches his own client and mints an op that reuses MAMA's stamp on a different entity.
  // It is well-formed: `validateOp` has no opinion about a stamp another device already used.
  const spoof = Object.freeze({ ...tomb, id: pad22('ZORROSPOOF'), e: noteKey(V), f: Object.freeze({ text: 'harmlos' }) });
  assert.equal(log.append(spoof, { seq: 3 }).status, 'appended',
    'non-vacuity: the duplicate-stamp op is ACCEPTED, so D7 does not cover it');
  assert.equal(spoof.ts, tomb.ts);

  assert.equal(log.seqOfOp(tomb.id), 900n, 'the seq index is keyed by opId — the spoof cannot reach it');
  assert.equal(log.seqOfOp(spoof.id), 3n, 'and the spoof keeps its own, correct seq');
  assert.equal(log.seqOf(tomb.ts), 900n,
    'the stamp view is the MAXIMUM over the colliding ops — never lowered, because down is unsafe');
  assert.deepEqual(
    log.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }),
    [],
    'the tombstone is collected 897 seqs early — every device that has not yet read past '
    + '900 can still hold an unpushed write against it (risk R15)');

  // …and it is still collectable on its OWN terms, once the fleet really has read past 900.
  assert.deepEqual(log.collectTombstones({ nowMs: NOW, minDeviceSeq: 900n, minPushedSeq: 900n }),
    [noteKey(U)], 'the rule became a blanket refusal instead of a rule');
});

test('RECHECK-A7-2 — CLOSED: the checkpoint is keyed by opId too, so a relaunch cannot inherit it', () => {
  const log = mk();
  const tomb = tombstone('TOMB2');
  log.append(tomb, { seq: 900 });
  const spoof = Object.freeze({ ...tomb, id: pad22('SPOOF2'), e: noteKey(V), f: Object.freeze({ text: 'x' }) });
  log.append(spoof, { seq: 3 });

  const disk = JSON.parse(JSON.stringify({ checkpoint: log.checkpoint(), tail: log.ops() }));
  const relaunched = mk();
  relaunched.load(disk);
  assert.equal(relaunched.seqOfOp(tomb.id), 900n,
    '`checkpoint().seqs` is keyed by stamp too, so the corruption is now on disk');
  assert.equal(relaunched.seqOf(tomb.ts), 900n);
  assert.deepEqual(relaunched.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }), []);

  // …and a relaunch from a COMPACTED file, where the seq lives only in the checkpoint, is the
  // case `seqs` exists for at all.
  log.compact();
  const cold = mk();
  cold.load(JSON.parse(JSON.stringify({ checkpoint: log.checkpoint(), tail: log.ops() })));
  assert.equal(cold.seqOfOp(tomb.id), 900n, 'the op→seq index did not survive compaction + reload');
  assert.deepEqual(cold.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }), []);

  // BACKWARD COMPATIBILITY: a pre-A7 file keyed `seqs` by STAMP. It must still load, and it must
  // still block — a checkpoint written by yesterday's build may not silently disarm condition 3.
  const legacy = JSON.parse(JSON.stringify(log.checkpoint()));
  legacy.seqs = { [tomb.ts]: '900' };
  const old = mk();
  old.load({ checkpoint: legacy, tail: [] });
  assert.equal(old.seqOf(tomb.ts), 900n, 'a stamp-keyed `seqs` map from an older build was refused');
  assert.deepEqual(old.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }), []);
  assert.deepEqual(old.collectTombstones({ nowMs: NOW, minDeviceSeq: 900n, minPushedSeq: 900n }),
    [noteKey(U)], 'and the legacy path still COLLECTS when the rule is satisfied');
});

test('RECHECK-A7-3 — CLOSED: the collision that needs no adversary, i.e. upgrade day', () => {
  // Migration stamps every op `GENESIS(index)` — wall clock 0, device short all-zeros (ADR 001
  // §8.1). Two different boards migrated into one personal space (my desktop`s board and my
  // laptop`s board, paired afterwards) therefore collide on stamps by construction, with
  // different entity keys, different opIds and different server seqs. This is a real user on the
  // day they upgrade, not an attack.
  const log = mk();
  const a = Object.freeze({ ...tombstone('GA'), ts: ZERO_STAMP });
  const b = Object.freeze({ ...me('note.set', noteKey(V), { text: 'vom Laptop' }, { ms: OLD, space: PSP, id: pad22('GB') }), ts: ZERO_STAMP });
  assert.equal(a.ts, b.ts, 'non-vacuity: two migrated ops really do share a stamp');
  log.append(a, { seq: 900 });
  log.append(b, { seq: 3 });

  assert.equal(log.seqOfOp(a.id), 900n,
    'no forgery is required — ZERO_DEVICE_SHORT stamps collide across two migrations');
  assert.equal(log.seqOfOp(b.id), 3n);
  assert.equal(log.seqOf(a.ts), 900n, 'the shared stamp reports the maximum, which is the safe side');
  assert.deepEqual(log.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }), [],
    'a migrated board collected its own tombstones early on upgrade day');

  // Arrival order must not matter either: the low seq arriving SECOND is the case that used to
  // overwrite, and the low seq arriving FIRST is the case that used to look fine.
  const reversed = mk();
  reversed.append(b, { seq: 3 });
  reversed.append(a, { seq: 900 });
  assert.equal(reversed.seqOfOp(a.id), 900n);
  assert.equal(reversed.seqOf(a.ts), 900n);
  assert.deepEqual(reversed.collectTombstones({ nowMs: NOW, minDeviceSeq: 20n, minPushedSeq: 20n }), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A7-4 — CLOSED (§12.5). `collectTombstones` used to delete LIVE op lines by entity,
// including ops this device had never pushed. §12.5 says "An op is never discarded for being
// old", and the same function's own docblock protects PARKED ops from exactly this deletion —
// but an unpushed line in `live` got no such protection. Reachable whenever our own write lost
// the LWW join to the tombstone: the "every register must be acked" guard cannot see it, because
// a losing write leaves no register behind to check.
//
// Note that DELETING was not even the safe half of the choice. Simply retaining the line while
// dropping the entity's registers would fold it straight back into a LIVE entity — R15 itself.
// The correct answer is the one condition 3(b) already gives: an entity we still hold an unpushed
// line for is not collectable at all.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A7-4 — CLOSED: an unpushed local line blocks collection instead of being destroyed', () => {
  const log = mk();
  const mine = me('note.set', noteKey(U), { text: 'meins' }, { ms: OLD, ctr: 1, space: PSP, id: pad22('UNPUSHED') });
  log.append(mine);                                  // no seq — still in our outbox
  log.append(tombstone('T4'), { seq: 100 });

  assert.equal(log.has(mine.id), true);
  assert.equal(log.seqOfOp(mine.id), null, 'non-vacuity: the op really is unacked');
  assert.equal(log.registers().get(noteKey(U)).get('text').stamp !== mine.ts, true,
    'non-vacuity: our write LOST the join, so it leaves no register for the ack guard to see');

  const dropped = log.collectTombstones({ nowMs: NOW, minDeviceSeq: 200n, minPushedSeq: 200n });
  assert.deepEqual(dropped, [], 'the entity was collected around an op still in our outbox');
  assert.equal(log.get(mine.id).id, mine.id,
    'an op that never reached the relay was deleted from the log (ADR 001 §12.5)');
  assert.equal(log.registers().has(noteKey(U)), true, 'and the tombstone itself is still there');

  // …and the moment the relay acks our line, the block lifts. It is a condition, not a veto.
  assert.equal(log.ack(mine.id, 150), true);
  assert.deepEqual(log.collectTombstones({ nowMs: NOW, minDeviceSeq: 200n, minPushedSeq: 200n }),
    [noteKey(U)], 'condition 3(b) turned into a permanent refusal');
  assert.equal(log.get(mine.id), null, 'an ACKED line is dropped with its entity, as §7.3 intends');
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — the parts of the A7 fix that hold. Each one fails against the pre-fix module.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A7-5 — CONTROL: the guard still refuses to decide without minPushedSeq', () => {
  const log = mk();
  log.append(tombstone('T5'), { seq: 1 });
  assert.throws(() => log.collectTombstones({ nowMs: NOW, minDeviceSeq: 9n }), /minPushedSeq/);
  assert.throws(() => log.collectTombstones({ nowMs: NOW, minPushedSeq: 9n }), /minDeviceSeq/);
  assert.throws(() => tombstoneCollectable(log.registers(), noteKey(U), { nowMs: NOW, minDeviceSeq: 9n, minPushedSeq: 9n }),
    /seqOf/);
});

test('RECHECK-A7-6 — CONTROL: an unacked register on ANY field blocks collection', () => {
  const log = mk();
  log.append(tombstone('T6'), { seq: 1 });
  // One later, unpushed write on a field the tombstone also wrote: it WINS, so it leaves a
  // register with no seq behind, and that must stop GC dead.
  log.append(me('note.set', noteKey(U), { text: 'noch nicht gepusht' },
    { ms: OLD + 1000, space: PSP, id: pad22('LATERUNPUSHED') }));
  assert.deepEqual(log.collectTombstones({ nowMs: NOW, minDeviceSeq: 999n, minPushedSeq: 999n }), []);
});

test('RECHECK-A7-7 — CONTROL: a parked op on the entity still blocks collection', () => {
  const log = mk();
  log.append(tombstone('T7'), { seq: 1 });
  const future = Object.freeze({
    ...me('note.set', noteKey(U), { text: 'sibling' }, { ms: OLD, ctr: 9, space: PSP, id: pad22('SIB') }),
    k: 'quest.set',
  });
  assert.equal(log.append(future).parkReason, 'unknownKind');
  assert.deepEqual(log.collectTombstones({ nowMs: NOW, minDeviceSeq: 999n, minPushedSeq: 999n }), [],
    '§7.4 beats §7.3');
});
