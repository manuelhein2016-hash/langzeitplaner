// FLEET · THE CONVERGENCE ADVERSARY — THE OUTBOX.  Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE HEADLINE: **FINDING E5-2 IS NOT CLOSED.** IT WAS NARROWED, AND THE HOLE THAT IS LEFT IS
// THE COMMON CASE RATHER THAN THE RARE ONE.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E5 found that `_persistOps` wrote a checkpoint whose horizon folded ops the relay had never
// seen, and closed it with `store._outboxHorizonCap()`:
//
//   > "A persist may not fold past the oldest line the relay has not acknowledged."
//
// The cap computes a FLOOR — the oldest stamp in `outbox()` — and then answers with
//
//   > "the greatest live stamp STRICTLY BELOW the floor, and no further"
//
// and stands down (`return undefined`, i.e. NO CAP AT ALL) when
//
//   ```js
//   const held = this._log.horizon();
//   if (held !== null && (cap === null || cmp(cap, held) < 0)) { …warn…; return undefined; }
//   ```
//
// That guard was written for one situation — "a checkpoint written by a build without this cap
// can legitimately already fold an unacknowledged op; nothing can put that line back" — and its
// `cap === null` arm fires in a completely different one:
//
//   **`cap === null` means "there is no live line older than the oldest unacknowledged one".**
//
// That is the state of EVERY log immediately after ANY compaction, because a compaction is
// precisely the operation that removes the older lines. So the sequence
//
//        compact  ▸  author  ▸  compact
//
// destroys the authored op: the second compaction has no live line below the floor, the guard
// reads that as "the horizon already folds an unacknowledged op", stands the cap down, and
// `compact()` then folds the line away for real. `outbox()` is derived from LINES, so the op
// silently leaves the outbox; `sync.status()` reports `healthy`; and the edit never reaches the
// other Mac, on that launch or on any later one.
//
// Both of ADR 001 §7.2's compaction triggers are live in the shipped store
// (`store.js:3515` — `_tailLines >= TAIL_COMPACT_AT` with `TAIL_COMPACT_AT = 1500`, and
// `_tailOverBytes`, set at `store.js:1788` from a `ops.jsonl` larger than 2 MB at launch), so
// this is story 19.1's own promise — "a laptop closed on a train" — failing at exactly the size
// story 19.6 is about.
//
// §1 is that defect, minimised, with the control that makes it a defect and not a rule.
// §2 is the rest of the outbox adversary: a lost ack, a lost response, a crash mid-push, a
// duplicate ack and a forged one.
//
// EVERYTHING HERE IS THE SHIPPED CODE. See `tests/helpers/fleet.js` for what is real.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, simClock } from '../helpers/fleet.js';
import { createPersonalSync } from '../../src/js/sync/personal.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'seed', date: '2027-03-04', text: 'Anfang', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/** ADR 001 §7.2's tail policy, armed by hand — the same move `long-offline.test.js` §2b uses. */
async function compact(dev) {
  dev.store._tailOverBytes = true;
  await dev.persist();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. E5-2, RE-OPENED
// ═════════════════════════════════════════════════════════════════════════════════════════════

// INVERTED, NOT REPAIRED. Two things landed, and BOTH are needed — reverting either one turns the
// first row below red, which is why they are named separately:
//
//   E5-2  `store._outboxHorizonCap()`'s stand-down asked the wrong question. `cap === null` means
//         only "no live line strictly below the outbox floor", and that is the state EVERY
//         compaction leaves behind — not an old file, not an adversary. Returning `undefined`
//         there is not standing down, it is handing the log back its own defaults and folding the
//         unacknowledged line for real. The stand-down belongs to `held >= floor` alone, and the
//         answer this state calls for is the persisted horizon itself.
//   L-4   `core/oplog.js` `load()` fed each tail line the `seq` its BYTES carry, and a tail line
//         is written before any ack exists, so it always says `null`. The durable ack lives in
//         `checkpoint().seqs`. An acknowledged op therefore came back looking unacknowledged, the
//         outbox floor sank below the persisted horizon, and `_outboxHorizonCap` was pushed into
//         the one arm that genuinely cannot recover — with no adversary and no old file, on any
//         Mac that quits after a compaction.
describe('§1 · CLOSED (E5-2, L-4) · the outbox cap holds the case it was written for', () => {
  test('compact ▸ author offline ▸ compact — the edit SURVIVES, and reaches the other Mac', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // ① An ordinary compaction on a fully-acknowledged log. Nothing is owed to the relay, so the
    //    cap is `undefined` by design and this compaction is the lossless one §7.2 describes.
    await compact(B);
    assert.equal(B.outboxSize(), 0, 'the precondition: nothing unacknowledged when ① runs');

    // ② The laptop is shut and the user types. This is 19.1, verbatim.
    B.offline();
    await B.apply('editNotePopover', { id: 'seed', text: 'Im Zug getippt' });
    assert.equal(B.outboxSize(), 1, 'the edit is queued');

    // THE CAP IS ASKED THE QUESTION AND ANSWERS WITH A STAMP BELOW THE FLOOR.
    const cap = B.store._outboxHorizonCap();
    assert.notEqual(cap, undefined,
      'E5-2: with no live line below the floor the cap must still be a STAMP — the persisted '
      + 'horizon, which is already folded and is below the floor — and never `undefined`, which '
      + 'is "no cap at all" and folds the line for real.');
    assert.ok(B.store._log.horizon() === null || cap === B.store._log.horizon()
      || cap === '0000000000000.000000.0000000000000000',
      `the cap is the persisted horizon or ZERO_STAMP; measured ${cap}`);

    // ③ The second compaction. ADR 001 §7.2's ordinary tail policy, nothing exotic.
    await compact(B);

    assert.equal(B.outboxSize(), 1,
      'THE FIX: the queued edit is still owed to the relay after a compaction that could see it');
    assert.equal(B.logOps().length, 1, 'and its LINE is still in the log — that is what the outbox is');

    // Nothing was lost, so nothing is reported. Silence is EARNED here, which is the half a fix
    // that reported an error for ever would also satisfy.
    assert.deepEqual(B.warnings().filter((w) => /finding E5-2/.test(w)), [],
      'the stand-down warning did not fire — this state is not the unrecoverable one');
    assert.equal(B.storeDiagnostics().sync.lost, 0, 'and `diagnostics().sync.lost` agrees');

    // ④ Back online, and it lands.
    B.online();
    await f.settle();
    await f.settle();
    assert.equal(A.state.notes[0].text, 'Im Zug getippt', 'the other Mac receives the edit');
    assert.equal(B.state.notes[0].text, 'Im Zug getippt');
    assert.equal(B.status().state, 'healthy',
      'STORY 19.3: the indicator draws nothing — and now that is TRUE');
    assert.equal(A.status().state, 'healthy');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);

    await B.relaunch();
    await f.settle();
    assert.equal(A.state.notes[0].text, 'Im Zug getippt', 'and a relaunch keeps it');
  });

  test('L-4 · the ack survives the quit, so an acknowledged op does not re-enter the outbox', async () => {
    // THE SECOND HALF, MINIMISED. `checkpoint().seqs` is the durable ack (`store.outbox()`'s own
    // docblock says so: "an op leaves the outbox when the server reports it … which rides in
    // `checkpoint().seqs` and so survives a relaunch"). The tail line's bytes say `seq: null`
    // because they were written before the push. `oplog.load()` fed the BYTES and dropped the
    // index, so every acknowledged op came back unacknowledged — which is what dragged the outbox
    // floor below the persisted horizon and pushed the cap into E5-2's unrecoverable arm.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    await B.apply('editNotePopover', { id: 'seed', text: 'gesendet und bestätigt' });
    await B.push();
    const oid = B.logOps().find((o) => o.f && o.f.text === 'gesendet und bestätigt').id;
    assert.equal(B.outboxSize(), 0, 'the relay acknowledged it');
    assert.notEqual(B.store._log.seqOfOp(oid), null, 'and the log recorded the seq');

    await B.relaunch();
    assert.equal(B.outboxSize(), 0,
      'IT IS STILL ACKNOWLEDGED after the quit — no phantom outbox entry for an op the relay has '
      + 'had all along (finding L-4).');
    assert.notEqual(B.store._log.seqOfOp(oid), null, 'and `seqOfOp` still answers for it');
    // Where the LINE still exists — it does not here, because a clean quit with an empty outbox
    // folds it — the line and the index must agree. The seam itself is minimised at
    // `tests/tier1/core-oplog.test.js` "L-4 · `load()` restores a tail line's ack", which drives a
    // checkpoint and a `seq: null` tail through `load()` directly and kills the mutant.
    const line = B.store._log.lines().find((l) => l.op.id === oid);
    if (line) assert.notEqual(line.seq, null, 'the line and the index agree');
  });

  test('SUCCEEDED (control) · one live line below the floor and the cap protects the edit', async () => {
    // THE MUTATION CHECK FOR THE ROW ABOVE. The only difference from §1 is that an ACKNOWLEDGED
    // op is left in the log below the unacknowledged one, so `cap` is a real stamp instead of
    // `null` and the guard does not fire. Same compaction, same trigger, same offline edit.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await compact(B);

    B.offline();
    await B.apply('editNotePopover', { id: 'seed', text: 'erste' });
    B.online();
    await B.push();                                   // …and that one IS acknowledged

    B.offline();
    await B.apply('editNotePopover', { id: 'seed', text: 'zweite' });
    const cap = B.store._outboxHorizonCap();
    assert.notEqual(cap, undefined, 'now the cap is a real stamp');

    await compact(B);
    assert.equal(B.outboxSize(), 1, 'and the queued edit survives the compaction');

    B.online();
    await f.settle();
    assert.equal(A.state.notes[0].text, 'zweite', 'and reaches the other Mac');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('the same thing at story-19.6 scale — a fortnight of edits, ALL of them survive', async () => {
    // The reachable shape in the field: a device whose whole live set is unacknowledged, which
    // is what a laptop that quit with a full outbox looks like on its next launch, and what an
    // offline device looks like after the first `TAIL_COMPACT_AT` lines.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await compact(B);

    B.offline();
    for (let i = 0; i < 12; i++) {
      await B.apply('createNotePopover', {
        id: `t${i}`, date: '2027-02-02', text: `Im Urlaub ${i}`, categoryId: 'c1',
      });
    }
    assert.equal(B.outboxSize(), 12);

    await compact(B);
    assert.equal(B.outboxSize(), 12,
      'ALL TWELVE survive the compaction. This is the reachable shape in the field — a laptop '
      + 'whose whole live set is unacknowledged — and it was the shape that lost every one of them.');

    B.online();
    await f.settle();
    await f.settle();
    assert.equal(A.state.notes.length, 13, 'the desktop receives the whole fortnight');
    assert.equal(B.state.notes.length, 13, 'and the laptop still shows every one of them');
    assert.equal(B.status().state, 'healthy');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE REST OF THE OUTBOX ADVERSARY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · a push that lands and an answer that does not', () => {
  test('FAILED · the relay stores the batch, the response is lost, the app quits — permanent `error`', async () => {
    // The relay's handler HAS RUN when `hostile.onResponse` sees the answer, so this is a real
    // "the write committed and the ack was lost", not a refusal. ADR 003 §3.1's whole argument
    // for at-least-once delivery is that this costs one duplicate push.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await B.apply('createNotePopover', { id: 'zug', date: '2027-05-01', text: 'Im Zug', categoryId: 'c1' });

    f.wire.hostile.onResponse = (res, req, who) => (
      req.method === 'POST' && req.path === '/api/v1/ops' && who === B.short
        ? { ...res, status: 502, body: { error: 'bad_gateway' } }
        : res);
    await B.push();
    f.wire.honest();

    assert.equal(B.outboxSize(), 1, 'the op is still queued, which is correct');
    await A.sync();
    assert.equal(A.state.notes.some((n) => n.id === 'zug'), true,
      'and the relay really did store it — the other Mac already has it');

    // The quit. `tests/helpers/fleet.js` builds the engine with NO `envelopeStore`, so the
    // sealed bytes are lost and the re-push re-seals with a fresh iv and a fresh ECDSA
    // signature. `server/core/handlers/ops.js` compares the STORED bytes: `409 forked_op_id`.
    await B.relaunch();
    await B.push();

    assert.deepEqual(B.quarantined().map((q) => q.reason), ['forked_op_id']);
    assert.equal(B.status().state, 'error', 'story 19.3 lights the indicator');
    assert.equal(B.status().errorKind, 'quarantine');
    assert.equal(B.outboxSize(), 1, 'and the line never leaves the outbox');

    await f.settle();
    assert.equal(B.status().state, 'error',
      'permanently: nothing retires a `forked_op_id` and nothing re-mints the op');
    // The BOARDS agree — the content was never at risk. What is broken is the indicator, for ever.
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('SUCCEEDED (control) · with the `envelopeStore` the product wires, the same crash costs one duplicate', async () => {
    // THE MUTATION CHECK. `src/js/family/engine.js` supplies `envelopeStore` over `localStorage`;
    // `tests/helpers/fleet.js` does not, so the fleet suite runs a configuration the product does
    // not ship. This row builds the SHIPPED engine with the SHIPPED port and shows the difference
    // is the whole of the row above — which is also the finding: the harness under-tests every
    // relaunch-with-a-non-empty-outbox in the suite.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    const kept = new Map();
    const build = () => createPersonalSync({
      store: B.store,
      transport: B.transport,
      keyring: B.ring,
      sigPriv: B.keys.identity.devSig.privateKey,
      spaceId: f.spaceId,
      deviceShort: B.short,
      attestationOf: (dv) => f.attestations.get(dv) || null,
      attestation: B.keys.attestation,
      now: () => f.clock.now(),
      isOnline: () => !B.isOffline,
      schedule: () => null,
      unschedule: () => {},
      envelopeStore: { load: (sp) => kept.get(sp) || [], save: (sp, e) => kept.set(sp, e) },
    });

    await B.apply('createNotePopover', { id: 'zug', date: '2027-05-01', text: 'Im Zug', categoryId: 'c1' });
    f.wire.hostile.onResponse = (res, req, who) => (
      req.method === 'POST' && req.path === '/api/v1/ops' && who === B.short
        ? { ...res, status: 502, body: { error: 'bad_gateway' } }
        : res);
    const first = build();
    await B.run(() => first.pushNow());
    f.wire.honest();
    assert.equal(kept.size, 1, 'the sealed bytes were made durable BEFORE the push');

    // The quit: a brand-new engine over the same store and the same envelope slot.
    const second = build();
    await B.run(() => second.pushNow());
    assert.deepEqual(second.quarantined(), [], 'no 409 — the bytes are the same bytes');
    assert.equal(second.status().state, 'healthy');
    assert.equal(B.outboxSize(), 0, 'and the op is acknowledged as a `duplicate`');
    await A.sync();
    assert.equal(A.state.notes.some((n) => n.id === 'zug'), true);
  });

  test('SUCCEEDED · a lost ACK (not a lost response) costs exactly one idempotent re-push', async () => {
    // The narrower crash: the answer arrives, the process dies before `ackPushed` reaches disk.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await B.apply('createNotePopover', { id: 'ack', date: '2027-05-02', text: 'Ack', categoryId: 'c1' });

    // The answer arrives and the process dies before `ackPushed` records it. Modelled at the one
    // seam where that is expressible: the store's own ack door, silenced for exactly one push.
    const realAck = B.store.ackPushed;
    B.store.ackPushed = () => 0;
    await B.push();
    B.store.ackPushed = realAck;
    assert.equal(B.outboxSize(), 1, 'so the op is still owed and is offered again');

    const before = f.wire.calls.length;
    await B.push();
    assert.equal(B.outboxSize(), 0, 'and the relay answers `duplicate`, which retires it');
    assert.ok(f.wire.calls.length > before);
    await A.sync();
    assert.equal(A.state.notes.filter((n) => n.id === 'ack').length, 1, 'exactly one entry, not two');
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('SUCCEEDED (bounded) · a duplicate ack is idempotent for the OUTBOX; a forged one buys nothing', async () => {
    const f = await twoMacs();
    const B = f.device('B');
    await f.settle();
    await B.apply('createNotePopover', { id: 'dup', date: '2027-05-03', text: 'D', categoryId: 'c1' });
    const oid = B.store.outbox()[0].op.id;
    await B.push();
    assert.equal(B.outboxSize(), 0);

    // Replay the same ack with a DIFFERENT seq. The line does not come back into the outbox…
    B.store.ackPushed([{ oid, seq: '999999' }]);
    assert.equal(B.outboxSize(), 0, 'the op stays acknowledged');
    assert.equal(B.cursor(), '0', 'and the transport CURSOR is untouched — the two are separate');

    // …and an ack naming an op nobody has moves nothing at all.
    assert.equal(B.store.ackPushed([{ oid: 'ZZZZZZZZZZZZZZZZZZZZZZ', seq: '5' }]), 0);
    assert.equal(B.store.ackPushed('not an array'), 0);
    assert.equal(B.store.ackPushed([null, {}, { oid: 42 }]), 0);
  });

  test('SUCCEEDED · a peer\'s op with NO seq can never enter this Mac\'s outbox', async () => {
    // The filter `op.dev === this._device`. `store.applyRemote`'s own docblock names the case:
    // "A batch handed in without seqs still works … it simply cannot leave the outbox, which the
    // outbox's own `op.dev === this._device` filter then catches." Without that filter, one such
    // op wedges the outbox permanently, because `POST /ops` refuses `e.dv !== auth.deviceShort`
    // with `403 device_mismatch` and nothing retires the line.
    //
    // MUTATION-CHECKED: removing the filter from `store.outbox()` reddens this row.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await B.apply('editNotePopover', { id: 'seed', text: 'von B' });
    const peerOp = B.logOps().find((o) => o.f && o.f.text === 'von B');

    // Handed in WITHOUT `meta.seqs`, which is how a `local` merge or a pre-LZP-502 caller does it.
    const r = await A.run(() => A.store.applyRemote([peerOp]));
    assert.deepEqual(r.applied, [peerOp.id], 'it is applied');
    assert.equal(A.state.notes[0].text, 'von B');
    assert.equal(A.store._log.lines().find((l) => l.op.id === peerOp.id).seq, null,
      'and its line carries no seq, which is the DEFINITION of the outbox');

    assert.equal(A.outboxSize(), 0, "…and yet a peer's line is not mine to push");
    assert.equal((await A.push()).pushed, 0);
    assert.equal(A.status().state, 'healthy', 'so nothing wedges');
  });
});
