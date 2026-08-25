// tests/attack/convergence-oplog.test.js
//
// CONVERGENCE ATTACKS against src/js/core/oplog.js.
// Every test here is an attempt to make two devices that hold the SAME set of ops disagree
// permanently. Tests named `CLOSED` were written to assert a defect that the attack pass found
// and that the fix pass then closed — they now assert the CORRECT behaviour, and each one fails
// against the pre-fix module. Tests named `CONTROL` assert a defence that held all along.
//
// Five defects were found here and all five are closed: A1 (envelope splice resolved by arrival
// order), A2 (the documented persist pair destroyed every parked op), A3 (tombstone GC deleted
// parked ops), A4 (park() after compaction was cosmetic), A7 (GC condition 3 bounded read
// progress but not unpushed writes). A6's other half lives in convergence-authz.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpLog, horizonBeforeMs, tombstoneCollectable, APPEND } from '../../src/js/core/oplog.js';
import { fold } from '../../src/js/core/registers.js';
import { noteKey } from '../../src/js/core/entities.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import {
  BASE_MS, DAY, HOUR, DEV, PSP, minter, shuffled, regsJSON, pad22,
} from './_kit.js';

const NOTE = '5e1a0000-0000-4000-8000-000000000001';
const now = () => BASE_MS;

// ─────────────────────────────────────────────────────────────────────────────
// A1 — CLOSED. ENVELOPE SPLICE: OpLog.append resolved "two bodies, one opId" by ARRIVAL ORDER.
//
// authz.js:494-498 resolves this content-addressably ("so every device picks the same one").
// oplog.js:350-353 did not: the FIRST body to arrive won and the second was reported CONFLICT,
// so two devices that received the same two envelopes in opposite orders held different
// registers, for ever, from an identical op set.
//
// FIXED in oplog.js `append()`: the same content-addressable rule as authz.js — the body whose
// `canonicalJSON` sorts higher stands, the loser is un-applied and re-folded, and the id is
// reported on `splicedIds()`. The test below is the inverse of the one that documented the bug.
// ─────────────────────────────────────────────────────────────────────────────

test('A1 CLOSED — one opId, two bodies: the surviving body is arrival-order independent', () => {
  const op = minter(DEV.mama);
  const ID = pad22('SPLICED');
  const bodyA = op('note.set', noteKey(NOTE), { text: 'Zahnarzt', date: '2026-09-10' },
    { ms: BASE_MS, space: PSP, id: ID });
  const bodyB = op('note.set', noteKey(NOTE), { text: 'GEFAELSCHT', date: '2026-09-10' },
    { ms: BASE_MS, space: PSP, id: ID });

  assert.equal(bodyA.id, bodyB.id, 'precondition: the two envelopes share one opId');
  assert.notDeepEqual(bodyA.f, bodyB.f);

  const deviceOne = createOpLog({ now });
  assert.equal(deviceOne.append(bodyA).status, APPEND.APPENDED);
  assert.equal(deviceOne.append(bodyB).status, APPEND.CONFLICT, 'a splice is still REPORTED, not swallowed');

  const deviceTwo = createOpLog({ now });
  assert.equal(deviceTwo.append(bodyB).status, APPEND.APPENDED);
  assert.equal(deviceTwo.append(bodyA).status, APPEND.CONFLICT);

  // Same set of bytes on the wire, one board.
  assert.equal(regsJSON(deviceOne.registers()), regsJSON(deviceTwo.registers()));

  // …and the winner is the content-addressable max, i.e. the same rule authz.js applies.
  const winner = canonicalJSON(bodyA) > canonicalJSON(bodyB) ? bodyA : bodyB;
  for (const d of [deviceOne, deviceTwo]) {
    assert.equal(d.registers().get('note:' + NOTE).get('text').value, winner.f.text);
    assert.deepEqual(d.get(ID).f, winner.f);
    assert.deepEqual(d.splicedIds(), [ID]);
  }

  // …and the report is a function of the SET: a re-pull that re-delivers a body changes nothing.
  for (const o of [bodyA, bodyB, bodyB, bodyA]) deviceOne.append(o);
  assert.deepEqual(deviceOne.splicedIds(), [ID]);
  assert.equal(regsJSON(deviceOne.registers()), regsJSON(deviceTwo.registers()));
});

test('A6 CLOSED (the oplog half) — a spliced op that PARKS is resolved the same way', () => {
  // A parked op is retained precisely so it can be applied after an app update. Resolving the
  // splice by arrival order for the parked half would merely defer the divergence to the update.
  const op = minter(DEV.mama);
  const ID = pad22('PARKSPLICE');
  const mk = (text) => Object.freeze({
    ...op('note.set', noteKey(NOTE), { text, date: '2026-09-10' }, { ms: BASE_MS, space: PSP, id: ID }),
    v: 2,                                       // a version this build does not know ⇒ parks
  });
  const a = mk('A');
  const b = mk('B');
  const winner = canonicalJSON(a) > canonicalJSON(b) ? a : b;

  for (const arrival of [[a, b], [b, a]]) {
    const log = createOpLog({ now });
    assert.equal(log.append(arrival[0]).status, APPEND.PARKED);
    assert.equal(log.append(arrival[1]).status, APPEND.CONFLICT);
    assert.equal(log.parkedSize, 1);
    assert.equal(log.parkReasonOf(ID), 'version', 'the park reason must survive the splice');
    assert.deepEqual(log.get(ID).f, winner.f);
    assert.deepEqual(log.splicedIds(), [ID]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — CLOSED. PARKED OPS WERE LOST BY THE DOCUMENTED PERSIST PAIR.
//
// ops.contract.js §8 types `load({checkpoint, tail: Op[]})`, and oplog.js states that
// `{checkpoint(), ops()}` "is the exact pair that belongs on disk". But `checkpoint()` folds
// only LIVE ops, and `ops()` used to exclude parked ops unless `includeParked` was passed — so
// the documented round trip destroyed every parked op on an ordinary relaunch: the exact "loses
// the new thing" failure ADR 001 §7.4 / §12.5 exist to prevent, with no adversary required.
//
// FIXED: `ops()` now yields every LINE the log holds — live, then parked — because that is what
// `ops.jsonl` contains. `{liveOnly:true}` is the opt-in for the applied ops alone. `load()`
// already re-classifies the whole tail, so a parked line simply re-parks.
// ─────────────────────────────────────────────────────────────────────────────

test('A2 CLOSED — a relaunch through {checkpoint(), ops()} preserves every parked op', () => {
  const op = minter(DEV.papa);
  const onTime = op('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'heute' },
    { ms: BASE_MS, space: PSP });
  // A peer whose clock runs 48 h fast: PARKED, never dropped (ADR 001 §7.4).
  const fromFuture = op('note.set', noteKey(NOTE), { text: 'aus der Zukunft' },
    { ms: BASE_MS + 2 * DAY, space: PSP });

  const before = createOpLog({ now });
  before.append(onTime);
  assert.equal(before.append(fromFuture).status, APPEND.PARKED);
  assert.equal(before.parkedSize, 1);

  // The persist pair, exactly as the module documents it, through JSON as a real file would be.
  const persisted = JSON.parse(JSON.stringify({ checkpoint: before.checkpoint(), tail: before.ops() }));
  // REG-29 moved the parked lines out of `ops()` and into `checkpoint()`, WITH their reasons —
  // `ops()` is the applied set again, because `fold(log.ops())` must not throw on a parked line.
  // The pair is still complete, which is all A2 ever asked for.
  assert.equal(persisted.tail.length, 1, 'ops() is the applied-ops view');
  assert.equal(persisted.checkpoint.parked.length, 1, 'the checkpoint silently omitted the parked line');
  assert.equal(before.ops({ liveOnly: true }).length, 1, 'liveOnly is the applied-ops view');

  const after = createOpLog({ now });
  after.load(persisted);
  assert.equal(after.parkedSize, 1, 'a relaunch destroyed the parked op');
  assert.equal(after.has(fromFuture.id), true);
  assert.equal(after.parkReasonOf(fromFuture.id), 'future');
  assert.equal(regsJSON(after.registers()), regsJSON(before.registers()));

  // …and it still re-evaluates once its prerequisite arrives — here, the clock passing it.
  const later = createOpLog({ now: () => BASE_MS + 3 * DAY });
  later.load(persisted);
  assert.equal(later.parkedSize, 0, 'the reloaded op did not re-classify on load');
  assert.equal(later.size, 2);
  assert.equal(later.registers().get('note:' + NOTE).get('text').value, 'aus der Zukunft');

  // …and it lands exactly where the peer that never relaunched lands. That is the divergence
  // the old behaviour produced: on the relaunched Mac the write no longer existed at all.
  const peer = createOpLog({ now: () => BASE_MS + 3 * DAY });
  peer.append(onTime);
  peer.append(fromFuture);
  assert.equal(regsJSON(peer.registers()), regsJSON(later.registers()));
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — CLOSED. TOMBSTONE GC DELETED PARKED OPS.
//
// §7.3's three conditions reason about the entity's REGISTERS. A parked op is by construction
// not in the registers and never contributed to condition 3 — it may even carry a NEWER stamp
// than every register the entity has. `collectTombstones` deleted it anyway, destroying a newer
// sibling's op that was retained precisely so an app update could apply it.
//
// FIXED: `collectTombstones` never touches the parked map, and an entity with ANY parked op is
// not collectable at all. §7.4 beats §7.3 — the tombstone simply waits.
// ─────────────────────────────────────────────────────────────────────────────

test('A3 CLOSED — collectTombstones keeps parked ops, and will not collect around one', () => {
  const op = minter(DEV.meDesk);
  const born = op('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'alt', _alive: true },
    { ms: BASE_MS, space: PSP });
  const killed = op('note.set', noteKey(NOTE), { _alive: false }, { ms: BASE_MS + 1000, space: PSP });

  // A parked op from a NEWER build: unknown field, retained for after the app update (§7.4/§10).
  const fromNewerBuild = {
    ...op('note.set', noteKey(NOTE), { text: 'neu' }, { ms: BASE_MS + 2000, space: PSP }),
  };
  fromNewerBuild.f = Object.freeze({ text: 'neu', reminderMinutes: 30 });
  Object.freeze(fromNewerBuild);

  const nowMs = BASE_MS + 500 * DAY;
  const gc = { nowMs, minDeviceSeq: 99n, minPushedSeq: 99n };

  // Without the parked op, all three §7.3 conditions hold and the entity IS collected.
  const control = createOpLog({ now: () => nowMs });
  control.append(born, { seq: 1 });
  control.append(killed, { seq: 2 });
  assert.deepEqual(control.collectTombstones(gc), ['note:' + NOTE],
    'precondition: all three §7.3 conditions hold for this entity');

  const log = createOpLog({ now: () => nowMs });
  log.append(born, { seq: 1 });
  log.append(killed, { seq: 2 });
  assert.equal(log.append(fromNewerBuild, { seq: 3 }).status, APPEND.PARKED);
  assert.equal(log.parkedSize, 1);

  assert.deepEqual(log.collectTombstones(gc), [], 'the GC collected around a parked op');
  assert.equal(log.parkedSize, 1, 'the retained forward-compatibility op was destroyed');
  assert.equal(log.has(fromNewerBuild.id), true);
  assert.equal(log.registers().has('note:' + NOTE), true);

  // A sibling that has not yet run GC holds exactly the same thing — no divergence, so after
  // the app update the two devices apply the same op set.
  const sibling = createOpLog({ now: () => nowMs });
  sibling.append(born, { seq: 1 });
  sibling.append(killed, { seq: 2 });
  sibling.append(fromNewerBuild, { seq: 3 });
  assert.equal(sibling.parkedSize, 1);
  assert.equal(regsJSON(sibling.registers()), regsJSON(log.registers()));
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — CLOSED. park() after compaction could not undo the write it had already folded in.
//
// FIXED by REFUSING: the line is gone and the write is inseparably merged into the checkpoint,
// so parking could only ever be cosmetic. Rebuilding the checkpoint from the surviving lines is
// not available — compaction dropped them, which is §7.2's whole point — so the choice is
// between lying and throwing, and it throws.
// ─────────────────────────────────────────────────────────────────────────────

test('A4 CLOSED — park() of an already-compacted op is refused, loudly', () => {
  const op = minter(DEV.meDesk);
  const a = op('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'A' }, { ms: BASE_MS, space: PSP });
  const log = createOpLog({ now });
  log.append(a);
  log.compact();
  assert.equal(log.size, 0);

  assert.throws(() => log.park(a, 'epoch'), /folded into the checkpoint/);
  assert.equal(log.isParked(a.id), false, 'the refused park parked it anyway');
  assert.equal(log.registers().get('note:' + NOTE).get('text').value, 'A',
    'the refusal must leave the log exactly as it was');

  // The reason it throws: a device that parked BEFORE compacting holds something different, and
  // silently accepting the call would have hidden that divergence behind `isParked() === true`.
  const other = createOpLog({ now });
  other.park(a, 'epoch');
  assert.equal(other.registers().has('note:' + NOTE), false);
  assert.notEqual(regsJSON(log.registers()), regsJSON(other.registers()));
});

// ─────────────────────────────────────────────────────────────────────────────
// A7 — CLOSED. R15 THROUGH THE OTHER DOOR: condition 3 bounded READ progress, not WRITES.
//
// ADR 001 §7.3 phrases condition 3 as `lastSeenSeq` only. A device can be fully caught up on
// reads and still hold ops it authored and never pushed — the outbox is not `lastSeenSeq`, and
// §12.5 guarantees those ops are never discarded for being old. Once the entity's registers are
// dropped there is no retained stamp left to absorb them, so such a write does not lose the
// join, it RECREATES the entry, however old it is.
//
// FIXED inside `tombstoneCollectable` (so no caller can arrange to skip it): condition 3 now
// requires `minPushedSeq` alongside `minDeviceSeq`, and refuses any entity whose own registers
// are not all acked. Omitting either throws. ADR CORRECTION: §7.3's condition 3 needs the write
// half added to its text.
// ─────────────────────────────────────────────────────────────────────────────

test('A7 CLOSED — a device with an unacked outbox blocks GC, so nothing is resurrected', () => {
  const desk = minter(DEV.meDesk);
  const laptop = minter(DEV.meLap);
  const KEY = 'note:' + NOTE;

  const born = desk('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'Zahnarzt', _alive: true },
    { ms: BASE_MS, space: PSP });
  const killed = desk('note.set', noteKey(NOTE), { _alive: false }, { ms: BASE_MS + DAY, space: PSP });
  // Authored on day 5 and stuck in the laptop's outbox for 500 days while it happily PULLED
  // everything — so its lastSeenSeq is current and only its lastPushedSeq lags.
  const stuckInOutbox = laptop('note.set', noteKey(NOTE), { text: 'Zahnarzt verschoben' },
    { ms: BASE_MS + 5 * DAY, space: PSP });

  const nowMs = BASE_MS + 500 * DAY;
  const mk = () => {
    const l = createOpLog({ now: () => nowMs });
    l.append(born, { seq: 1 });
    l.append(killed, { seq: 2 });
    return l;
  };

  // Reads are caught up (500 ≫ 2); writes are not (the laptop last drained its outbox at 1).
  const a = mk();
  assert.equal(tombstoneCollectable(a.registers(), KEY, { nowMs, minDeviceSeq: 500n, minPushedSeq: 1n, seqOf: a.seqOf }),
    false, 'the read half alone said yes — that is R15');
  assert.deepEqual(a.collectTombstones({ nowMs, minDeviceSeq: 500n, minPushedSeq: 1n }), []);

  // The peer that simply had not run GC yet.
  const b = mk();

  // The laptop finally pushes. §12.5: both logs ADMIT the op, however old it is.
  for (const log of [a, b]) assert.equal(log.append(stuckInOutbox, { seq: 900 }).status, APPEND.APPENDED);

  assert.equal(a.registers().get(KEY).get('_alive').value, false, 'the entry came back from the dead');
  assert.equal(regsJSON(a.registers()), regsJSON(b.registers()),
    'the device that ran GC and the device that did not must agree');

  // And the guard cannot be evaded by simply not passing the data.
  assert.throws(() => a.collectTombstones({ nowMs, minDeviceSeq: 500n }), /minPushedSeq/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — defences that held.
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL — compaction is lossless against a late op OLDER than the horizon', () => {
  const desk = minter(DEV.meDesk);
  const mama = minter(DEV.mama);
  const early = mama('note.set', noteKey(NOTE), { text: 'frueh' }, { ms: BASE_MS + 1000, space: PSP });
  const late = desk('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'spaet' },
    { ms: BASE_MS + 5000, space: PSP });

  const compacted = createOpLog({ now });
  compacted.append(late);
  compacted.compact({ horizon: horizonBeforeMs(BASE_MS + 9999) });
  compacted.append(early);                     // arrives three weeks late, below the horizon

  assert.equal(
    regsJSON(compacted.registers()),
    regsJSON(fold([early, late])),
    'fold(checkpoint ∪ tail) === fold(all ops) for any partition (ADR 001 §7.2)',
  );
});

test('CONTROL — append is permutation- and duplication-invariant for honest ops', () => {
  const desk = minter(DEV.meDesk);
  const mama = minter(DEV.mama);
  const ops = [
    desk('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'a', _alive: true }, { ms: BASE_MS, space: PSP }),
    mama('note.set', noteKey(NOTE), { text: 'b' }, { ms: BASE_MS, space: PSP }),
    desk('note.set', noteKey(NOTE), { _alive: false }, { ms: BASE_MS + 5, space: PSP }),
    mama('note.set', noteKey(NOTE), { text: 'c' }, { ms: BASE_MS + 5, space: PSP }),
  ];
  const reference = regsJSON(fold(ops));
  for (let seed = 1; seed <= 64; seed++) {
    const log = createOpLog({ now });
    for (const o of shuffled([...ops, ...ops], seed)) log.append(o);
    assert.equal(regsJSON(log.registers()), reference, `permutation seed ${seed}`);
  }
});

test('CONTROL — no staleness gate: a stamp of zero is admitted at any nowMs (R11)', () => {
  const desk = minter(DEV.meDesk);
  const ancient = desk('note.set', noteKey(NOTE), { date: '1970-01-01', text: 'Omas Geburtstag' },
    { ms: 0, space: PSP });
  const log = createOpLog({ now: () => BASE_MS + 900 * DAY });
  assert.equal(log.append(ancient).status, APPEND.APPENDED);
});

test('CONTROL — a future-parked op converges once the clock passes it', () => {
  const desk = minter(DEV.meDesk);
  const papa = minter(DEV.papa);
  const mine = desk('note.set', noteKey(NOTE), { date: '2026-09-10', text: 'meins' },
    { ms: BASE_MS, space: PSP });
  const theirs = papa('note.set', noteKey(NOTE), { text: 'ihres' }, { ms: BASE_MS + 2 * DAY, space: PSP });

  const slow = createOpLog({ now: () => BASE_MS });
  slow.append(mine); slow.append(theirs);
  const fast = createOpLog({ now: () => BASE_MS + 2 * DAY + HOUR });
  fast.append(mine); fast.append(theirs);
  assert.notEqual(regsJSON(slow.registers()), regsJSON(fast.registers()), 'transiently apart');

  const caughtUp = createOpLog({ now: () => BASE_MS + 3 * DAY });
  caughtUp.append(mine); caughtUp.append(theirs);
  assert.equal(regsJSON(caughtUp.registers()), regsJSON(fast.registers()));
});
