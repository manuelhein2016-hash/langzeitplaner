// tests/attack/convergence-materialize.test.js
//
// CONVERGENCE ATTACKS against the projection: tombstone GC (R15), "absent vs explicit null" (R9)
// and non-deterministic iteration order leaking into the materialized board.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpLog } from '../../src/js/core/oplog.js';
import { tombstoneCollectable } from '../../src/js/core/oplog.js';
import { fold, emptyRegisters, applyOp, mergeMaps } from '../../src/js/core/registers.js';
import { materialize } from '../../src/js/core/materialize.js';
import { noteKey, familyKey } from '../../src/js/core/entities.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import {
  attestationBlob, attestVerify, DEVICES, ME, MAMA, PSP, FSP,
} from '../helpers/gen.js';
import { BASE_MS, DAY, minter, shuffled, regsJSON } from './_kit.js';
import { memberKey, spaceKey } from '../../src/js/core/entities.js';

const M = (d) => minter(d, { fsp: FSP });
const DEV = {
  meDesk: DEVICES.find((d) => d.name === 'me-desktop'),
  meLap: DEVICES.find((d) => d.name === 'me-laptop'),
  mama: DEVICES.find((d) => d.name === 'mama-mac'),
};
const NOTE = '5e1a0000-0000-4000-8000-000000000001';
const KEY = noteKey(NOTE);
const soloCtx = { me: ME, familySpaceId: null };

// ─────────────────────────────────────────────────────────────────────────────
// A7 CLOSED — R15: condition 3 now bounds UNPUSHED WRITES as well as READ progress.
//
// The defect: §7.3 condition 3 read "every registered device reports `lastSeenSeq` past the seq
// of that stamp's op". A device that has PULLED past the tombstone can still be sitting on a
// write it authored BEFORE it pulled and has not managed to PUSH — the outbox is not
// `lastSeenSeq`, and §12.5 guarantees that write will not be discarded for being old. Once GC
// has dropped the registers there is no stamp left for the tombstone to win the join with, so
// the entry came back on the device that collected and stayed dead on the one that had not.
//
// The fix is in the guard itself (`oplog.js:tombstoneCollectable`), not in its callers: the ctx
// now REQUIRES `minPushedSeq` — the fleet minimum of `lastPushedSeq`, i.e. the seq high-water at
// which every device last confirmed a drained outbox — and returns false unless BOTH minima have
// passed the tombstone. Omitting it throws rather than defaulting to something permissive.
//
// ADR CORRECTION (text not yet amended): ADR 001 §7.3 condition 3 states only the `lastSeenSeq`
// half. It must also require write progress — `min(lastPushedSeq)`.
// ─────────────────────────────────────────────────────────────────────────────

test('A7 CLOSED — an unacked outbox blocks GC, so the deferred push resurrects nothing', () => {
  const desk = M(DEV.meDesk);
  const laptop = M(DEV.meLap);

  const born = desk('note.set', KEY, { date: '2026-09-10', text: 'Zahnarzt', categoryId: 'c1', _alive: true },
    { ms: BASE_MS, space: PSP });
  const killed = desk('note.set', KEY, { _alive: false }, { ms: BASE_MS + DAY, space: PSP });

  // The laptop's two offline ops, authored on day 5 — AFTER the delete's stamp — and stuck in
  // its outbox for 500 days while it happily PULLED everything (so its lastSeenSeq is current).
  const movedOffline = laptop('note.set', KEY, { date: '2026-11-01' }, { ms: BASE_MS + 5 * DAY, space: PSP });
  const editedOffline = laptop('note.set', KEY, { text: 'Zahnarzt verschoben' },
    { ms: BASE_MS + 5 * DAY + 1000, space: PSP });

  const nowMs = BASE_MS + 500 * DAY;
  const mk = () => {
    const l = createOpLog({ now: () => nowMs });
    l.append(born, { seq: 1 });
    l.append(killed, { seq: 2 });
    return l;
  };

  // ── Device A tries to collect while the laptop's outbox is still undrained. ────────────────
  // Reads are fully caught up (minDeviceSeq 500) — conditions 1 and 2 hold, and the OLD
  // condition 3 held too. What blocks it is the write high-water: the laptop last confirmed a
  // drained outbox at seq 1, before the tombstone at seq 2.
  const a = mk();
  const withOutbox = { nowMs, minDeviceSeq: 500n, minPushedSeq: 1n, seqOf: a.seqOf };
  assert.equal(tombstoneCollectable(a.registers(), KEY, withOutbox), false,
    'THE FIX: read progress is not enough — an undrained outbox blocks collection');
  assert.deepEqual(a.collectTombstones(withOutbox), [], 'and the sweep collects nothing');

  // NOT VACUOUS — the same log, same nowMs, same entity, with the fleet drained past the
  // tombstone, DOES collect. So the refusal above is minPushedSeq biting, not conditions 1/2
  // quietly failing and the assertion passing for the wrong reason.
  const control = mk();
  const drained = { nowMs, minDeviceSeq: 500n, minPushedSeq: 500n, seqOf: control.seqOf };
  assert.equal(tombstoneCollectable(control.registers(), KEY, drained), true,
    'control: with every outbox drained past the tombstone, all three conditions hold');
  assert.deepEqual(control.collectTombstones(drained), [KEY]);

  // The guard cannot be evaluated away: omitting the new input throws rather than defaulting.
  assert.throws(
    () => tombstoneCollectable(a.registers(), KEY, { nowMs, minDeviceSeq: 500n, seqOf: a.seqOf }),
    /minPushedSeq must be a BigInt/,
  );

  // ── Device B: same op set, has simply not run GC yet (it compacts less often). ──
  const b = mk();

  // ── The laptop finally pushes. Both devices admit both ops (§12.5: never too old). ──
  for (const log of [a, b]) {
    for (const op of [movedOffline, editedOffline]) {
      assert.equal(log.append(op, { seq: 900 }).status, 'appended');
    }
  }

  const boardA = materialize(a.registers(), soloCtx);
  const boardB = materialize(b.registers(), soloCtx);

  // THE POINT: identical op sets, identical boards, and the delete stands on both.
  assert.equal(boardA.notes.length, 0, 'the entry the user deleted is still deleted');
  assert.equal(boardB.notes.length, 0);
  assert.equal(JSON.stringify(boardA), JSON.stringify(boardB), 'no divergence');
  assert.equal(a.registers().get(KEY).get('_alive').value, false,
    'the tombstone register survived, so it still absorbs the late writes');
  assert.equal(regsJSON(a.registers()), regsJSON(b.registers()),
    'and the register maps themselves are identical, not merely the projections');
});

// ─────────────────────────────────────────────────────────────────────────────
// A8 CLOSED — forget() is refused on an entity that is still published.
//
// The defect: `forget` blanks register VALUES in place while retaining their stamps and opIds,
// and `registers.js:valueKey` ranks `null` ABOVE every other value, so the blank wins the exact
// (stamp, opId) tie. That is correct — and deliberate — for the retraction case the pass was
// designed for, because a retraction must be absorbing. But the function had no guard against
// being called on an entity that is still published, and there the blank is unrecoverable: no
// re-delivery of the original ops can restore it, while every peer that did not run the pass
// still shows the value. Permanent divergence from a mistaken call, not from an adversary.
//
// The fix is a LIVENESS GUARD inside `forget` (`oplog.js`, step (a)): an unscoped forget runs
// only on an entity the owner actually retracted (`pub.alive === false` or `pub.level ===
// 'privat'`; `_alive === false` for personal kinds). The two legitimate ADR 004 §5.3 callers
// keep an explicit way in — `{fields:[…]}` for the trigger (ii) downgrade (that register is
// already null; the pass only removes plaintext from `ops.jsonl`), and `{values:'all'}` for a
// deliberate hard purge. The irreversibility itself is NOT a defect and is still asserted below.
// ─────────────────────────────────────────────────────────────────────────────

test('A8 CLOSED — forget() on a still-published entity is REFUSED, so peers cannot diverge', () => {
  const w = family();
  const share = w.me('pub.set', w.fkey, {
    'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-09-10',
  }, { ms: BASE_MS + 100, space: FSP });

  const mine = createOpLog({ now: () => BASE_MS + DAY });
  const peer = createOpLog({ now: () => BASE_MS + DAY });
  for (const log of [mine, peer]) log.append(share);

  // THE FIX: the entity is published (`pub.alive` true, level 'belegt'), so the unscoped pass
  // that would blank it irreversibly is refused — loudly, naming both escape hatches.
  assert.throws(() => mine.forget(w.fkey, FSP), /still live/);

  // and the refusal is TOTAL: not one register moved, not one line was purged.
  assert.equal(mine.registers().get(w.fkey).get('pub.date').value, '2026-09-10');
  assert.equal(regsJSON(mine.registers()), regsJSON(peer.registers()),
    'THE POINT: the mistaken call left me byte-identical to the peer that never made it');
  assert.equal([...mine.ops()].length, [...peer.ops()].length, 'and the line is still there');

  const viewCtx = { me: MAMA, familySpaceId: FSP, currentMembers: new Set([ME, MAMA]), members: new Map() };
  assert.equal(materialize(mine.registers(), viewCtx).notes.length, 1);
  assert.equal(materialize(peer.registers(), viewCtx).notes.length, 1);

  // ── The mechanism the guard protects is intact. After a real retraction the pass runs, and
  //    it is still absorbing — which is exactly what ADR 004 §5.3 requires of it. ────────────
  const retract = w.me('pub.set', w.fkey, { 'pub.level': 'privat', 'pub.alive': false },
    { ms: BASE_MS + 200, space: FSP });
  mine.append(retract);
  assert.ok(mine.forget(w.fkey, FSP) > 0, 'a retracted entity CAN be forgotten');
  assert.equal(mine.registers().get(w.fkey).get('pub.date').value, null);

  // Irreversible by design: re-delivering the very op that wrote it does not bring it back,
  // because `valueKey` ranks the blank above the value at the identical (stamp, opId).
  const relaunched = createOpLog({ now: () => BASE_MS + DAY });
  relaunched.load({ checkpoint: mine.checkpoint(), tail: mine.ops() });
  assert.equal(relaunched.append(share).status, 'appended');
  assert.equal(relaunched.registers().get(w.fkey).get('pub.date').value, null,
    'the retraction wins the tie — a redaction that a re-pull could undo would be no redaction');

  // NOT VACUOUS — the guard is a liveness test, not a blanket refusal of this entity/space pair.
  // A second log that never retracted still gets the throw, so the `> 0` above is the retraction
  // doing the work rather than the guard being absent all along.
  const other = createOpLog({ now: () => BASE_MS + DAY });
  other.append(share);
  assert.throws(() => other.forget(w.fkey, FSP), /still live/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL — materialize does not leak register-map iteration order', () => {
  const desk = M(DEV.meDesk);
  const ops = [];
  for (let i = 0; i < 6; i++) {
    const u = `5e1a0000-0000-4000-8000-00000000000${i}`;
    ops.push(desk('note.set', noteKey(u), {
      date: '2026-09-10', text: `n${i}`, categoryId: 'cat-1', _alive: true, _born: '0000000000000.000000.0000000000000000',
    }, { ms: BASE_MS + i, space: PSP }));
    ops.push(desk('cat.set', `cat:cat-${i}`, { name: `k${i}`, visible: true, _alive: true },
      { ms: BASE_MS + 100 + i, space: PSP }));
    ops.push(desk('bar.set', `bar:b${i}0000-0000-4000-8000-000000000000`, {
      startDate: '2026-02-10', endDate: '2026-04-20', label: `b${i}`, _alive: true,
    }, { ms: BASE_MS + 200 + i, space: PSP }));
    ops.push(desk('pad.set', `pad:2026-0${i + 1}`, { text: `p${i}` }, { ms: BASE_MS + 300 + i, space: PSP }));
  }
  // `startMonth` is not decoration: ATT-97's guard refuses a pinned board without one, because
  // `layout.js:25` would `parseISO('null-01')` and `holidays.js:51` would then loop forever on a
  // NaN year. A pinned fixture that omits it is not exercising iteration order at all.
  ops.push(desk('pref.set', 'pref:app',
    { mode: 'pinned', startMonth: '2026-03', 'layers.feiertage': false, rowHeight: 30 },
    { ms: BASE_MS + 400, space: 'local' }));

  const reference = JSON.stringify(materialize(fold(ops), soloCtx));
  for (let s = 1; s <= 50; s++) {
    const regs = emptyRegisters();
    for (const op of shuffled(ops, s)) applyOp(regs, op);
    assert.equal(JSON.stringify(materialize(regs, soloCtx)), reference, `insertion order seed ${s}`);
  }
  // …and a checkpoint/tail split must not change it either (ADR 001 §7.2).
  const half = Math.floor(ops.length / 2);
  assert.equal(
    JSON.stringify(materialize(mergeMaps(fold(ops.slice(0, half)), fold(ops.slice(half))), soloCtx)),
    reference,
  );
});

test('CONTROL — R9: a co-editor\'s explicit null clears my text; an absent field does not', () => {
  const w = family();
  const truth = w.me('note.set', KEY, { date: '2026-09-10', text: 'Zahnarzt', _alive: true },
    { ms: BASE_MS + 10, space: PSP });
  const share = w.me('pub.set', w.fkey, {
    'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt',
  }, { ms: BASE_MS + 20, space: FSP });
  const clear = w.mama('pub.set', w.fkey, { 'pub.text': null }, { ms: BASE_MS + 30, space: FSP });
  const silent = w.mama('pub.set', w.fkey, { 'pub.date': '2026-09-11' }, { ms: BASE_MS + 30, space: FSP });

  const ctx = { me: ME, familySpaceId: FSP, currentMembers: new Set([ME, MAMA]), members: new Map() };

  const cleared = materialize(foldAuthorized([...w.setup, truth, share, clear], w.ctx).regs, ctx);
  assert.equal(cleared.notes.length, 0, 'text cleared ⇒ the note is no longer renderable');

  const untouched = materialize(foldAuthorized([...w.setup, truth, share, silent], w.ctx).regs, ctx);
  assert.equal(untouched.notes[0].text, 'Zahnarzt', 'an omitted field is NOT a clear');
  assert.equal(untouched.notes[0].date, '2026-09-11');
});

test('CONTROL — an admin unshare never blanks the owner\'s own note (INV-R3)', () => {
  const w = family();
  const truth = w.me('note.set', KEY, { date: '2026-09-10', text: 'Zahnarzt', _alive: true },
    { ms: BASE_MS + 10, space: PSP });
  const share = w.me('pub.set', w.fkey, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt',
  }, { ms: BASE_MS + 20, space: FSP });
  // MAMA is the admin here; the unshare patch must be EXACT.
  const unshare = w.mama('pub.set', w.fkey, {
    'pub.level': 'privat', 'pub.coEdit': null, 'pub.alive': null,
    'pub.date': null, 'pub.text': null, 'pub.repeatsYearly': null,
  }, { ms: BASE_MS + 40, space: FSP });

  const r = foldAuthorized([...w.setupMamaAdmin, truth, share, unshare], w.ctx);
  assert.equal(r.rejectionOf(unshare.id), null, 'precondition: the unshare was admitted');
  const board = materialize(r.regs, { me: ME, familySpaceId: FSP, currentMembers: new Set([ME, MAMA]), members: new Map() });
  assert.equal(board.notes.length, 1);
  assert.equal(board.notes[0].text, 'Zahnarzt', 'my own board still tells me the truth');
  assert.equal(board.notes[0].level, 'privat');
});

// ─────────────────────────────────────────────────────────────────────────────

function family() {
  const me = M(DEV.meDesk);
  const mama = M(DEV.mama);
  const fkey = familyKey('fnote', ME, NOTE);
  const base = [
    me('member.set', memberKey(ME), { [`dev.${DEV.meDesk.short}`]: attestationBlob(ME, DEV.meDesk) },
      { ms: BASE_MS - 9000, space: FSP }),
    me('member.set', memberKey(ME), { [`dev.${DEV.meLap.short}`]: attestationBlob(ME, DEV.meLap) },
      { ms: BASE_MS - 8900, space: FSP }),
    mama('member.set', memberKey(MAMA), { [`dev.${DEV.mama.short}`]: attestationBlob(MAMA, DEV.mama) },
      { ms: BASE_MS - 8000, space: FSP }),
    me('member.set', memberKey(ME), { displayName: 'Ich', _alive: true }, { ms: BASE_MS - 6000, space: FSP }),
    mama('member.set', memberKey(MAMA), { displayName: 'Mama', _alive: true }, { ms: BASE_MS - 5000, space: FSP }),
  ];
  const setup = [...base, me('space.set', spaceKey(FSP), { admin: ME, adminPrev: null }, { ms: BASE_MS - 3000, space: FSP })];
  const setupMamaAdmin = [...base, mama('space.set', spaceKey(FSP), { admin: MAMA, adminPrev: null },
    { ms: BASE_MS - 3000, space: FSP })];
  return {
    me, mama, fkey, setup, setupMamaAdmin,
    ctx: { me: ME, nowMs: BASE_MS + 10 * 3600000, attestVerify },
  };
}
