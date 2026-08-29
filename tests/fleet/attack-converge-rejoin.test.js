// FLEET · THE CONVERGENCE ADVERSARY — THE QUARANTINE, AND WHAT A RE-JOIN COSTS THE PEER.
// ADR 006 §7, §9.3 (W2), §9.4 · Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE QUESTION THIS FILE WAS SET
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > "A device that quarantines and re-joins (ADR 006 §9.3) — does it converge, or silently
//   >  re-join at the bottom of the order with GENESIS stamps under its old name? §7 and §9.3 W2
//   >  disagreed about this once; check what the code does."
//
// The code does BOTH, and which one it does turns on a field of `board.json` rather than on the
// quarantine reason. `store.init()` builds the re-derivation as
//
//     this._buildSpine(board, { restamp: !!binding })
//
// where `binding` is `board.json`'s `_v2.lineageId`, and `this._rejoined = this._syncArmed &&
// !!this.quarantine && !!binding`. So:
//
//   · **`board.json` HAS a lineage** → `restamp: true` → §9.4's `'now'` re-derivation, and
//     `_rejoined` is reported. §1 shows this converges, and §2 shows what it costs the PEER.
//   · **`board.json` has NO lineage** → `restamp: false` → **GENESIS stamps** → `store.outbox()`
//     filters every GENESIS-stamped op by design ("the spine is shared PREHISTORY, not traffic")
//     → **the whole board is never published**, and `_rejoined` is `false`, so ADR 006 §9.3's
//     "a quarantine is a visible, reported, converging event, never a quiet one" is false in
//     exactly the case W2 was written about. §3.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// AND THE HALF W2 SAYS IT FIXED, WHICH IT DOES NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// R4-7b, quoted in §9.3: *"a device that silently rejoins with GENESIS stamps loses every field
// contest and UN-DELETES ON ITS PEERS."* §9.4's answer is `stampBase: 'now'`. But `'now'` is not
// a fix for the un-delete — it is the mechanism of it. The re-derivation is taken from THIS Mac's
// `board.json`, which is as old as its last sync; stamping those stale values at `now` makes them
// beat everything the PEER did in the meantime. §2 measures both faces:
//
//   · the peer's newer EDIT is overwritten by the re-joining Mac's older value;
//   · the peer's DELETE is undone — the entry comes back, on the peer's own screen.
//
// Both converge. Neither loses the re-joining Mac anything. Both silently destroy work on the
// Mac that did nothing wrong, and ADR 006 §7's promise 4 — *"a quarantine can never cost content.
// Not 'does not' — CANNOT"* — is a statement about the LOCAL board only. At WP-8 scale it is
// false, and nothing in §9 says so.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, simClock, HOUR } from '../helpers/fleet.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [
    { id: 'zahnarzt', date: '2027-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false },
    { id: 'abgesagt', date: '2027-03-05', text: 'Elternabend', categoryId: 'c1', repeatsYearly: false },
  ],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/**
 * ADR 006 §7's `foreign-lineage` — "another board's log", the reason a Time-Machine restore or a
 * copied file actually produces, and the one reason that re-mints the lineage. `board.json` is
 * left alone, so the binding survives and `restamp` is `true`.
 */
function forgeForeignLineage(dev) {
  const cp = JSON.parse(dev.disk.getItem('langzeitplaner.checkpoint'));
  cp.lzp = { ...cp.lzp, lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ' };
  dev.disk.setItem('langzeitplaner.checkpoint', JSON.stringify(cp));
}

/** ADR 006 §7's `board-carries-no-lineage` — a hand-edited or restored `board.json`. */
function stripLineage(dev) {
  const board = JSON.parse(dev.disk.getItem('langzeitplaner.board'));
  delete board._v2;
  dev.disk.setItem('langzeitplaner.board', JSON.stringify(board, null, 2));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE LINEAGE-BEARING RE-JOIN CONVERGES, AND IS REPORTED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · SUCCEEDED · a re-join over a lineage-bearing board converges and says so', () => {
  test('the stamps are at `now`, `_rejoined` is true, and the whole projection is republished', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    await B.close();
    forgeForeignLineage(B);
    await B.open();

    assert.equal(B.storeDiagnostics().quarantine.reason, 'foreign-lineage');
    assert.equal(B.storeDiagnostics().sync.rejoin, true,
      'ADR 006 §9.3 W2 — a re-join is a VISIBLE event');
    // …but the ENGINE only learns it inside `attach()` (`stats.rejoin = store.diagnostics()
    // .sync?.rejoin`), which is the one thing `tests/helpers/fleet.js` never calls. So the whole
    // fleet suite — this file included — measures W2's reporting through the store and never
    // through `sync.diagnostics()`, and an engine built but not attached reports `false` on a
    // real re-join. Recorded, and mutation-checked on the next line.
    assert.equal(B.diagnostics().rejoin, false, 'the un-attached engine has not been told');
    await B.run(() => B.engine.attach());
    assert.equal(B.diagnostics().rejoin, true, 'attach() is where it is read');
    B.engine.detach();
    assert.equal(B.state.notes.length, 2, 'the board is intact — board.json is the truth (R1)');
    assert.ok(B.outboxSize() > 0,
      'the whole personal projection is republished: after a quarantine the log IS the spine and '
      + 'every line is unacknowledged');
    assert.equal(B.parked().length, 0, 'and none of it is parked');

    await f.settle();
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
    assert.deepEqual(B.quarantined(), [], 'nothing was refused on the way back in');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. WHAT IT COSTS THE PEER
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · FAILED · the re-join overwrites the peer, and un-deletes on it', () => {
  test('the peer\'s NEWER edit loses to the re-joining Mac\'s STALE value', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // The laptop is shut. The desktop keeps working — an hour later it corrects an appointment.
    B.offline();
    await B.close();
    f.clock.advance(HOUR);
    await A.apply('editNotePopover', { id: 'zahnarzt', text: 'Zahnarzt 9 Uhr (verschoben)' });
    await A.push();

    // The laptop's log is refused. §9.4 re-derives its board — which is an hour out of date —
    // at `now`, i.e. ABOVE the desktop's correction.
    forgeForeignLineage(B);
    await B.open();
    B.online();
    await B.catchUp();
    await f.settle();
    await f.settle();

    assert.equal(boardsAgree([A, B]).equal, true,
      'they CONVERGE — this is not a divergence, which is what makes it hard to see');
    assert.equal(A.state.notes.find((n) => n.id === 'zahnarzt').text, 'Zahnarzt',
      'and they converge on the STALE value: the desktop\'s correction is gone from the desktop. '
      + 'ADR 006 §9.4 stamps the re-derivation at `now` precisely so that it wins, and this is the '
      + 'other face of that. If this row ever reads "Zahnarzt 9 Uhr (verschoben)", the re-join has '
      + 'been made to yield to a stamp it has not seen and this test should be inverted.');
    // ── THE SILENCE HALF IS CLOSED (F-8); THE DATA HALF ABOVE IS STILL THE FINDING ────────────
    //
    // What this row measured before was a re-join that overwrote a peer AND said nothing. The
    // second half is now false: `store.warnings` has a consumer, it is enumerated in
    // `sync/status.js` as an observable, and `sync/personal.js`'s `status()` folds it in. The
    // re-joining Mac reports `error` and can name all three sentences — the quarantine, the
    // move-aside and the re-publication — which is ADR 006 §9.3's "a quarantine is a VISIBLE,
    // REPORTED, converging event, never a quiet one", now true rather than asserted.
    //
    // The PEER still says nothing, and that is still right: nothing failed on A. What A lost is a
    // contest, at stamps that are genuinely newer, and no layer here can tell that from an
    // ordinary edit. That is the part of this finding that is still open, and §9.4 owns it.
    assert.equal(B.status().silent, false,
      'the re-joining Mac no longer claims silence (F-8). `store.warnings` has a consumer, it is '
      + 'enumerated in `sync/status.js`, and `status()` folds it in. If this reads `true` again, '
      + 'the channel has lost its consumer — invert this line back rather than deleting it.');
    assert.ok(B.status().observables.some((o) => o.id === 'warnings'),
      'and the fold names the channel it came from');
    assert.ok(B.warnings().some((w) => /RE-JOIN/i.test(w)),
      'and it can say WHICH event: the §9.3 re-publication, by name');
    assert.equal(B.status().state, 'healthy',
      'the INDICATOR stays quiet, deliberately: a re-join is ADR 006 §9.3\'s "visible, reported, '
      + 'CONVERGING event", not a fault, and `store.warnings` is a mixed channel that also carries '
      + 'repairs and cures. Only sharp evidence — a parked line, a refusal, a lost line, a forked '
      + 'chain — lights it. See `sync/status.js`\'s `warnings` row.');
    assert.equal(A.status().state, 'healthy',
      'THE FINDING, narrowed to what is still true: the PEER is told nothing. Its own correction '
      + 'lost a stamp contest to a re-derivation it cannot distinguish from an ordinary edit.');
  });

  test('the peer\'s DELETE is undone — R4-7b\'s "un-deletes on its peers", still live', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    B.offline();
    await B.close();
    f.clock.advance(HOUR);
    await A.apply('deleteNotePopover', { id: 'abgesagt' });
    await A.push();
    assert.equal(A.state.notes.some((n) => n.id === 'abgesagt'), false, 'the desktop deleted it');

    forgeForeignLineage(B);
    await B.open();
    B.online();
    await B.catchUp();
    await f.settle();
    await f.settle();

    assert.equal(B.state.notes.some((n) => n.id === 'abgesagt'), true,
      'the re-joining Mac never saw the delete and re-mints the entry at `now`');
    assert.equal(A.state.notes.some((n) => n.id === 'abgesagt'), true,
      'THE FINDING: the deleted entry is back on the Mac that deleted it. §9.3 quotes R4-7b as the '
      + 'thing W2 exists to prevent, and §9.4\'s `stampBase: \'now\'` is the mechanism that causes '
      + 'it. If this row goes false, the re-join has learned to respect a tombstone it has not '
      + 'seen and this test should be inverted.');
    assert.equal(boardsAgree([A, B]).equal, true, 'converged, on the resurrected entry');
  });

  test('SUCCEEDED (control) · with nothing for the peer to lose, the re-join is harmless', async () => {
    // THE MUTATION CHECK for the two rows above: the same quarantine, the same `'now'` stamps, and
    // a peer that made no change while the laptop was away. Nothing is overwritten and nothing is
    // resurrected, which is what makes the two rows above statements about the PEER'S WORK and not
    // about quarantines in general.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    B.offline();
    await B.close();
    f.clock.advance(HOUR);
    forgeForeignLineage(B);
    await B.open();
    B.online();
    await f.settle();
    await f.settle();
    assert.equal(A.state.notes.length, 2);
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE SILENT ONE — A RE-JOIN THAT PUBLISHES NOTHING AND REPORTS NOTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · FAILED · a quarantine on a board with no lineage strands everything this Mac alone had', () => {
  test('GENESIS stamps, an empty outbox, `rejoin === false`, `healthy` on both Macs, for ever', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // The laptop works offline for a while. `nurB` exists in its `board.json` and in its log.
    B.offline();
    await B.close();
    await B.open();
    await B.apply('createNotePopover', {
      id: 'nurB', date: '2027-06-06', text: 'Nur auf dem Laptop', categoryId: 'c1',
    });
    await B.close();
    assert.equal(
      JSON.parse(B.disk.getItem('langzeitplaner.board')).notes.some((n) => n.id === 'nurB'), true,
      'the precondition: board.json holds it',
    );

    // `board.json` loses its `_v2` — a restore from a backup written by a pre-v2 build, a hand
    // edit, or any of ADR 006 §5's `board-carries-no-lineage` inputs.
    stripLineage(B);
    await B.open();

    assert.equal(B.storeDiagnostics().quarantine.reason, 'board-carries-no-lineage');
    assert.equal(B.state.notes.some((n) => n.id === 'nurB'), true,
      'promise 4 holds LOCALLY: the board is whole');
    assert.equal(B.storeDiagnostics().sync.rejoin, false,
      'THE FINDING, HALF ONE: `_rejoined` is gated on the same `binding` that gates `restamp`, so '
      + 'the one case that re-derives at GENESIS is also the one case that is NOT reported. ADR 006 '
      + '§9.3: "a visible, reported, converging event, never a quiet one."');
    assert.equal(B.outboxSize(), 0,
      'THE FINDING, HALF TWO: the whole re-derivation is GENESIS-stamped, and `store.outbox()` '
      + 'filters GENESIS stamps by design ("the spine is shared PREHISTORY, not traffic"). There '
      + 'is nothing to push.');

    B.online();
    for (let i = 0; i < 4; i++) {
      await f.settle();
      await B.relaunch();
      await A.relaunch();
    }
    await f.settle();

    assert.equal(B.state.notes.some((n) => n.id === 'nurB'), true);
    assert.equal(A.state.notes.some((n) => n.id === 'nurB'), false,
      'the desktop never receives it — not on this launch and not on any of four more');
    assert.equal(boardsAgree([A, B]).equal, false, 'a permanent divergence');
    assert.deepEqual([A.status().state, B.status().state], ['healthy', 'healthy'],
      'with the indicator drawing nothing on either Mac');
    assert.equal(B.storeDiagnostics().quarantine, null,
      'and by now the quarantine has been cleared by a later launch, so even the diagnostic is gone');
  });

  test('SUCCEEDED (control) · an edit made AFTER the same quarantine does travel', async () => {
    // THE MUTATION CHECK: the sync path is not broken by the quarantine — only the re-derivation
    // is unpublishable. This is why the failure above is silent rather than obvious.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await B.close();
    stripLineage(B);
    await B.open();
    await B.apply('editNotePopover', { id: 'zahnarzt', text: 'nach der Quarantäne' });
    assert.equal(B.outboxSize(), 1, 'a fresh op is stamped at `now` and is pushable');
    await f.settle();
    assert.equal(A.state.notes.find((n) => n.id === 'zahnarzt').text, 'nach der Quarantäne');
  });
});
