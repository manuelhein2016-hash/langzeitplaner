// tests/attack/recheck-a2-park-persistence.test.js
//
// SECOND ADVERSARY PASS against the A2 fix (parked ops surviving persist/load).
//
// The fix made `ops()` return every LINE, so the documented `{checkpoint(), ops()}` pair no
// longer destroys a parked op's BYTES. That half holds — `RECHECK-A2-CONTROL` pins it.
//
// What that fix did NOT restore was the round trip's MEANING. `load()` re-classifies the tail, and
// a classifier in `core/` cannot re-derive `epoch` — the docstring on `park()` says so itself:
// "In practice that is exactly one reason — `epoch`: whether we hold an epoch key is a fact about
// `crypto/spacekeys.js`, and core/ holds no key material." So the one park reason that exists
// because the classifier cannot reach it was the one reason a relaunch silently dropped.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// CLOSED IN ROUND 2. The tests below are INVERTED — each asserts the behaviour it used to assert
// the absence of. Three changes:
//
//   A2-a  `checkpoint()` now carries the parked LINES together with their REASONS, and `load()`
//         feeds a persisted `epoch` back through the classifier as `haveEpochKey:false`. The park
//         survives the relaunch as a park, not merely as bytes; `parkedOps({reason:'epoch'})` can
//         still tell the store it needs a key; and the re-classification that makes yesterday's
//         `unknownKind` today's ordinary op is untouched, because that reason is re-derived.
//   A2-b  `forget()` never deletes a parked line — the same rule `collectTombstones` states in
//         full — and its liveness guard now runs whether or not the entity has a fold.
//   REG-28 `checkpoint().spliced` carries the ADR 002 §5.1 tamper evidence across a relaunch.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpLog } from '../../src/js/core/oplog.js';
import { noteKey } from '../../src/js/core/entities.js';
import { BASE_MS, DEV, PSP, minter, pad22, regsJSON } from './_kit.js';

const U = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = BASE_MS + 1000;
const mk = () => createOpLog({ now: () => NOW });
const me = minter(DEV.meDesk);

const sealedNote = (id) => me('note.set', noteKey(U),
  { date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-1', repeatsYearly: false, _alive: true },
  { ms: BASE_MS, space: PSP, id: pad22(id) });

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A2-1 — CLOSED. The park REASON is part of the persist pair now, so an op parked under
// `epoch` comes back parked, under `epoch`, and stays unapplied until the key arrives.
//
// Sequence, all of it inside the documented API:
//   1. an op arrives sealed under an epoch key this device does not hold; the store parks it
//      (`park(op,'epoch')` — the one reason `append()` cannot derive, by design);
//   2. the app persists the documented pair `{checkpoint(), ops()}`;
//   3. the app relaunches and calls `load()` with exactly that pair.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A2-1 — CLOSED: an epoch-parked op comes back PARKED, and un-parks when the key does', () => {
  const log = mk();
  const op = sealedNote('EPOCHOP');
  log.append(op);
  log.park(op, 'epoch');

  // Non-vacuity: before the round trip the park is real — nothing is applied.
  assert.equal(log.isParked(op.id), true);
  assert.equal(log.parkReasonOf(op.id), 'epoch');
  assert.equal(log.registers().has(noteKey(U)), false, 'pre-condition: a parked op writes nothing');

  const disk = JSON.parse(JSON.stringify({ checkpoint: log.checkpoint(), tail: log.ops() }));
  const relaunched = mk();
  relaunched.load(disk);

  assert.equal(relaunched.has(op.id), true, 'the BYTES survive — that much the round-1 fix did fix');
  assert.equal(relaunched.isParked(op.id), true, 'the op is no longer parked after a relaunch');
  assert.equal(relaunched.parkReasonOf(op.id), 'epoch',
    'the park reason is not carried by the documented persist pair');
  assert.equal(relaunched.parkedOps({ reason: 'epoch' }).length, 1,
    'the store cannot discover that it still needs the epoch key');
  assert.equal(relaunched.registers().has(noteKey(U)), false,
    'the op the log was told not to apply has been applied');

  // …and END TO END: the key arrives, the store unparks, and the op is applied — once.
  const promoted = relaunched.unpark((o) => o.id === op.id);
  assert.deepEqual(promoted.map((o) => o.id), [op.id]);
  assert.equal(relaunched.isParked(op.id), false);
  assert.equal(relaunched.parkedOps({ reason: 'epoch' }).length, 0);
  assert.equal(relaunched.registers().get(noteKey(U)).get('text').value, 'Zahnarzt');

  // …landing exactly where a device that never restarted lands after the same key fetch.
  log.unpark((o) => o.id === op.id);
  assert.equal(regsJSON(relaunched.registers()), regsJSON(log.registers()));
});

test('RECHECK-A2-2 — CLOSED: the relaunch is invisible to state', () => {
  // Two devices, ONE op set. Device A relaunched this morning; device B did not. ADR 001 §0.2
  // says state is a function of the SET, so these two must agree.
  const op = sealedNote('EPOCHOP2');

  const stayedUp = mk();
  stayedUp.append(op);
  stayedUp.park(op, 'epoch');

  const relaunched = mk();
  relaunched.append(op);
  relaunched.park(op, 'epoch');
  relaunched.load(JSON.parse(JSON.stringify({ checkpoint: relaunched.checkpoint(), tail: relaunched.ops() })));

  assert.equal(regsJSON(relaunched.registers()), regsJSON(stayedUp.registers()),
    'two devices holding an identical op set disagree, and the only difference is that '
    + 'one of them was restarted');
  assert.equal(relaunched.parkReasonOf(op.id), stayedUp.parkReasonOf(op.id));

  // A SECOND relaunch must not erode it either — the reason has to round-trip, not merely survive
  // one hop. (A checkpoint written from a reloaded log is where a one-hop fix would show up.)
  const twice = mk();
  twice.load(JSON.parse(JSON.stringify({ checkpoint: relaunched.checkpoint(), tail: relaunched.ops() })));
  assert.equal(twice.parkReasonOf(op.id), 'epoch');
  assert.equal(regsJSON(twice.registers()), regsJSON(stayedUp.registers()));
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A2-3 — CLOSED. `forget()` no longer touches a parked op, and its liveness guard runs
// whether or not the entity has a fold.
//
// `collectTombstones` was already careful about this and said so: "PARKED OPS ARE NEVER TOUCHED …
// Deleting it here would destroy a newer sibling's write that was retained precisely so an app
// update could apply it — 'loses the new thing', §7.4's whole reason to exist." `forget()` deleted
// from the SAME map with no such rule.
//
// The liveness guard did not help either. It was written `if (!all && only === null && current)`
// and `current` is `api.registers().get(e)` — the FOLD. An entity that exists only as a parked op
// has no fold, so `current` was undefined and the guard was skipped entirely. The op was then
// deleted from `parked` while its id stayed in `seen`, so re-delivery answered DUPLICATE and the
// op was unrecoverable from the network as well as from disk.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A2-3 — CLOSED: forget() refuses a parked-only entity, and never deletes a parked op', () => {
  const log = mk();
  // An op from a newer sibling build: retained under §7.4 so that an app update can apply it.
  const fromTheFuture = sealedNote('PARKONLY');
  log.append(fromTheFuture);
  log.park(fromTheFuture, 'unknownKind');

  assert.equal(log.parkedSize, 1);
  assert.equal(log.registers().has(noteKey(U)), false,
    'non-vacuity: the entity has NO registers — it exists only as a parked line');

  // No {values:'all'}, no {fields:[…]}: the unscoped call the liveness guard exists to refuse.
  // An entity with no registers has no retraction either, so it is refused for the same reason
  // every other unretracted entity is.
  assert.throws(() => log.forget(noteKey(U), PSP), /still live/,
    'the unscoped forget was accepted on an entity with no fold — the guard was skipped');
  assert.equal(log.parkedSize, 1, 'the parked op is gone');
  assert.equal(log.get(fromTheFuture.id).id, fromTheFuture.id, 'its bytes are unrecoverable');

  // And the two documented escape hatches do not become a back door either: a parked line is a
  // §7.4 retention, not a §5.3 leak, so neither the hard purge nor the scoped downgrade takes it.
  for (const opts of [{ values: 'all' }, { fields: ['text'] }]) {
    const l = mk();
    l.append(fromTheFuture);
    l.park(fromTheFuture, 'unknownKind');
    assert.equal(l.forget(noteKey(U), PSP, opts), 0, `forget(${JSON.stringify(opts)}) purged a line`);
    assert.equal(l.parkedSize, 1, `forget(${JSON.stringify(opts)}) destroyed the parked op`);
    assert.equal(l.get(fromTheFuture.id).id, fromTheFuture.id);
  }

  // …and it still un-parks correctly afterwards, which is the thing that was being destroyed.
  const promoted = log.unpark((o) => o.id === fromTheFuture.id);
  assert.deepEqual(promoted.map((o) => o.id), [fromTheFuture.id]);
  assert.equal(log.registers().get(noteKey(U)).get('text').value, 'Zahnarzt');
});

test('RECHECK-A2-4 — non-vacuity control: the same guard DOES fire for a live folded entity', () => {
  const log = mk();
  log.append(sealedNote('LIVEONE'));
  assert.throws(() => log.forget(noteKey(U), PSP), /still live/,
    'the liveness guard works — it is only reachable when the entity has a fold');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A2-5 — CONTROL. The half of A2 that WAS fixed: a parked op's bytes survive the
// documented pair, including across a compaction whose horizon is above the parked op's stamp.
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A2-5 — CONTROL: parked BYTES survive compaction and the persist pair', () => {
  const log = mk();
  // A genuinely unknown kind from a newer sibling build — a reason the CLASSIFIER can re-derive,
  // unlike `epoch`. This is the case the A2 fix was aimed at and it holds.
  const parked = Object.freeze({
    ...me('note.set', noteKey(U), { text: 'alt' }, { ms: BASE_MS, ctr: 1, space: PSP, id: pad22('OLDPARK') }),
    k: 'quest.set',
  });
  const live = me('note.set', noteKey('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), { text: 'neu' },
    { ms: BASE_MS + 60_000, space: PSP, id: pad22('LIVE') });
  assert.equal(log.append(parked).parkReason, 'unknownKind', 'non-vacuity: it parks on its own');
  log.append(live);
  log.compact();                                   // horizon runs past the parked op's stamp

  const relaunched = mk();
  relaunched.load({ checkpoint: log.checkpoint(), tail: log.ops() });
  assert.equal(relaunched.has(parked.id), true, 'the parked line survived compaction and the round trip');
  assert.equal(relaunched.isParked(parked.id), true,
    'and it re-parks, because `unknownKind` is a reason the classifier CAN re-derive');
});

// ─────────────────────────────────────────────────────────────────────────────
// RECHECK-A2-6 / REG-28 — CLOSED. `splicedIds()` is documented as "a function of the op SET", and
// the set on disk holds only the WINNING body as a line, so the report cannot be re-derived from
// the tail. It is therefore persisted: `checkpoint().spliced`. A forgery signal that an ordinary
// restart erases is not tamper evidence (ADR 002 §5.1).
// ─────────────────────────────────────────────────────────────────────────────

test('RECHECK-A2-6 — CLOSED: splicedIds() survives the persist pair', () => {
  const log = mk();
  const low = me('note.set', noteKey(U), { text: 'aaa' }, { ms: BASE_MS, space: PSP, id: pad22('SPLICE1') });
  const high = { ...low, f: Object.freeze({ text: 'zzz' }) };
  log.append(low);
  assert.equal(log.append(high).status, 'conflict', 'non-vacuity: the splice IS detected');
  assert.equal(log.splicedIds().length, 1);

  const disk = JSON.parse(JSON.stringify({ checkpoint: log.checkpoint(), tail: log.ops() }));
  const relaunched = mk();
  relaunched.load(disk);
  assert.deepEqual(relaunched.splicedIds(), log.splicedIds(),
    'the forgery signal is erased by a restart, from the same op set');

  // …and it survives a compaction, and a relaunch from a compacted file, which is where the
  // evidence used to be doubly unrecoverable (the losing body is not a line any more either).
  log.compact();
  assert.deepEqual(log.splicedIds(), [low.id]);
  const cold = mk();
  cold.load(JSON.parse(JSON.stringify({ checkpoint: log.checkpoint(), tail: log.ops() })));
  assert.deepEqual(cold.splicedIds(), [low.id]);
});
