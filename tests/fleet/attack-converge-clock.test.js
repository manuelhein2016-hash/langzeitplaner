// FLEET · THE CONVERGENCE ADVERSARY — THE CLOCK, UNDER SYNC.
// ADR 001 §1.3, §7.4 · ADR 006 §7.1, §9.4, §12.6 · round 7 / R6-4 · Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT ROUND 7 FIXED, AND WHAT THIS FILE ASKS OF IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 6 measured the cost of reading ADR 006 §12.6 as "every LINE the log carries": one
// ordinary op stamped 48 h ahead quarantined a whole history, on every launch, for as long as the
// stamp stayed ahead. Round 7 narrowed it to the three things that DECIDE STATE — live ops,
// register cells, the checkpoint horizon — and moved the ordering fix into `applyRemote`, which
// withholds `nowMs` from the authorisation fold so a date cannot pre-empt authorisation.
//
// The blast radius is therefore claimed to be **that op and nothing else**. `long-offline.test.js`
// §2c asserts that on ONE PULL. This file asserts it under the rest of the lifecycle — a
// compaction, a persist, a relaunch — and then asks the three questions round 7 did not:
//
//   §1  Does a parked `future` op SURVIVE, and what is the cost of the cursor having moved past
//       it? (SUCCEEDED, with a named consequence.)
//   §2  What does a Mac more than 24 h fast look like to its peer? (FAILED — invisible, with
//       `healthy` on both.)
//   §3  Is the clock RATCHET bounded? A peer op inside the window drags the receiving Mac's HLC
//       with it. (SUCCEEDED — bounded at 24 h from the receiving Mac's own wall clock.)
//   §4  What happens when the HLC ends up more than 24 h above the wall clock and `init()` runs?
//       (FAILED, HIGH — `_buildSpine({restamp:true})` mints the whole re-derivation above the
//       park boundary, every spine op parks as `future`, and the board projects EMPTY with
//       `bootFailure === null` and a quarantine detail that says "board.json was kept whole".)
//
// `store._clock` is bound to the real `Date.now()` (`store.js:1220`), so a stamp in the future is
// built by hand and sealed for real — the same technique `long-offline.test.js` §2c uses — and a
// displaced MACHINE clock is modelled by displacing `Date.now` for the duration of a session,
// which is the only place a wall clock enters this tree.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, simClock, HOUR } from '../helpers/fleet.js';
import { fmt } from '../../src/js/core/stamp.js';
import { opId as newOpId } from '../../src/js/core/ids.js';
import { sealOp } from '../../src/js/crypto/envelope.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [
    { id: 'n1', date: '2027-03-04', text: 'Anfang', categoryId: 'c1', repeatsYearly: false },
    { id: 'weg', date: '2027-03-05', text: 'zu löschen', categoryId: 'c1', repeatsYearly: false },
  ],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/** Run `fn` with this machine's wall clock displaced. The ONLY wall clock in the tree. */
async function withWallClock(ms, fn) {
  const real = Date.now;
  Date.now = () => real.call(Date) + ms;
  try { return await fn(); } finally { Date.now = real; }
}

/**
 * Put one hand-built op on the relay under A's real identity and real signing key. `sealOp`
 * checks every header field against the op, so nothing here is a fabrication the peer would not
 * have accepted from a genuinely fast Mac.
 */
async function inject(f, A, op) {
  const env = await sealOp(op, A.ring, A.keys.identity.devSig.privateKey, {
    v: 1, sp: f.spaceId, ep: 1, dv: A.short, oid: op.id, wit: '',
  }, { attestation: A.keys.attestation });
  const res = await A.run(() => A.transport.request('POST', '/api/v1/ops', undefined, {
    space: f.spaceId, ackSeq: A.cursor(), ops: [env],
  }));
  assert.equal(res.status, 200, `the relay stores bytes and has no opinion about a stamp: ${JSON.stringify(res.json)}`);
  return env;
}

/** A copy of an op this Mac really authored, re-stamped `hours` ahead and given a fresh id. */
function ahead(model, hours, short, patch) {
  return {
    ...model,
    id: newOpId(),
    ts: fmt(Date.now() + hours * 3600 * 1000, 0, short),
    f: { ...model.f, ...patch },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE BLAST RADIUS, UNDER THE REST OF THE LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · SUCCEEDED · a 25 h-ahead op costs that op, and survives a compaction and a quit', () => {
  test('parked, not applied, not dropped — and the cursor has moved past it', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    await A.apply('editNotePopover', { id: 'n1', text: 'ganz normal' });
    const model = A.logOps().find((o) => o.f && o.f.text === 'ganz normal');
    const future = ahead(model, 25, A.short, { text: 'aus der Zukunft' });
    await A.push();
    await inject(f, A, future);
    await B.catchUp();

    assert.equal(B.state.notes.find((n) => n.id === 'n1').text, 'ganz normal',
      'the ordinary op beside it was applied');
    assert.deepEqual(B.parked().map((l) => l.park), ['future'], 'and the future one is parked');
    assert.equal(B.parked()[0].op.id, future.id);
    assert.deepEqual(B.quarantined(), [], 'nothing was refused');
    assert.equal(B.storeDiagnostics().quarantine, null, 'and the LOG was not quarantined for a date');

    // THE CONSEQUENCE WORTH NAMING: the cursor has moved past it, so the relay will never serve
    // it again. From here the parked LINE is the only copy this Mac has.
    const again = await B.run(() => B.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: B.cursor(), limit: '500' }, null, {},
    ));
    assert.equal(again.json.ops.length, 0, 'a re-pull from the cursor returns nothing');

    // …and the only copy survives everything the lifecycle does to a log.
    for (let i = 0; i < 14; i++) {
      await B.apply('createNotePopover', { id: `z${i}`, date: '2027-08-08', text: `z${i}`, categoryId: 'c1' });
    }
    B.store._tailOverBytes = true;
    await B.persist();
    assert.deepEqual(B.parked().map((l) => l.park), ['future'],
      'ADR 001 §7.2: "Parked ops are NEVER dropped" — a compaction does not touch it');

    await B.relaunch();
    assert.deepEqual(B.parked().map((l) => l.park), ['future'],
      'and `checkpoint().parked` carries it, with its reason, across a quit');
    assert.equal(B.state.notes.find((n) => n.id === 'n1').text, 'ganz normal',
      'still not applied');
    assert.equal(B.storeDiagnostics().quarantine, null,
      'R6-4: a PARKED stamp may not raise the §12.6 ceiling, so no launch quarantines for it');
  });

  test('SUCCEEDED (control) · 23 h ahead is INSIDE the window and is applied normally', async () => {
    // THE MUTATION CHECK FOR THE BOUNDARY. Same op, same author, same signing key, two hours less.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'ganz normal' });
    const model = A.logOps().find((o) => o.f && o.f.text === 'ganz normal');
    await A.push();
    await inject(f, A, ahead(model, 23, A.short, { text: 'fast Zukunft' }));
    await B.catchUp();
    assert.equal(B.state.notes.find((n) => n.id === 'n1').text, 'fast Zukunft');
    assert.equal(B.parked().length, 0, 'nothing parks inside MAX_FUTURE_DRIFT_MS');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. A MAC MORE THAN 24 h FAST IS INVISIBLE TO ITS PEER
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · FAILED · a fast Mac syncs nothing, and neither Mac is told', () => {
  test('everything it wrote parks on the peer; both report `healthy`; the boards disagree', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // The desktop's clock is 25 h fast for one afternoon — a dead CMOS battery, a resumed VM
    // snapshot, a botched NTP step. Its OWN board is perfect: `store._clockSkew` compares against
    // this Mac's own wall clock, so nothing here is wrong locally.
    await withWallClock(25 * HOUR, async () => {
      await A.apply('editNotePopover', { id: 'n1', text: 'Termin abgesagt' });
      await A.apply('deleteNotePopover', { id: 'weg' });
      await A.push();
    });
    await B.catchUp();

    assert.equal(A.state.notes.find((n) => n.id === 'n1').text, 'Termin abgesagt');
    assert.equal(B.state.notes.find((n) => n.id === 'n1').text, 'Anfang',
      'the laptop never sees the cancellation');
    assert.equal(B.state.notes.some((n) => n.id === 'weg'), true,
      'nor the deletion');
    assert.deepEqual(B.parked().map((l) => l.park), ['future', 'future'],
      'both ops are parked, which is exactly right per op…');
    assert.deepEqual([A.status().state, B.status().state], ['healthy', 'healthy'],
      '…and yet BOTH indicators draw nothing. `sync.status()` counts the engine\'s `deferred` and '
      + '`quarantined` sets and knows nothing about the STORE\'s parked lines, so a Mac that has '
      + 'parked everything its peer has ever said still reports `healthy`.');
    assert.equal(B.deferredOps().length, 0, 'the engine is not holding them — the store is');
    assert.equal(boardsAgree([A, B]).equal, false, 'and the two Macs disagree');

    // The cursor is past them, so this state persists until the wall clock passes the stamps and
    // some later launch re-classifies them — at which point they win every contest made in the
    // meantime, because they are stamped above it.
    await B.relaunch();
    await B.catchUp();
    assert.equal(B.state.notes.find((n) => n.id === 'n1').text, 'Anfang',
      'a relaunch inside the 25 h changes nothing');
    assert.deepEqual(B.parked().map((l) => l.park), ['future', 'future']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE RATCHET IS BOUNDED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · SUCCEEDED · a peer inside the window drags this Mac\'s clock, and it stops there', () => {
  test('one 23 h-ahead op puts every later local stamp 23 h ahead — and no further', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('editNotePopover', { id: 'n1', text: 'ganz normal' });
    const model = A.logOps().find((o) => o.f && o.f.text === 'ganz normal');
    await A.push();
    await inject(f, A, ahead(model, 23, A.short, { text: 'fast Zukunft' }));
    await B.catchUp();

    await B.apply('createNotePopover', { id: 'danach', date: '2027-09-09', text: 'danach', categoryId: 'c1' });
    const mine = B.logOps().find((o) => o.f && o.f.text === 'danach');
    const drift = Number(mine.ts.slice(0, 13)) - Date.now();
    assert.ok(drift > 22 * HOUR && drift < 24 * HOUR,
      `ADR 001 §1.3: \`observe\` adopts a stamp inside the window, so this Mac now mints ${Math.round(drift / HOUR)} h `
      + 'ahead of its own wall clock. That is the design; it is recorded here because it is the '
      + 'input to §4.');

    // A SECOND op 23 h ahead of the RECEIVING Mac's wall clock cannot push it further: `observe`
    // measures against the wall clock, not against the HLC, so the drift does not compound.
    await inject(f, A, ahead(model, 23, A.short, { text: 'noch fast Zukunft' }));
    await B.catchUp();
    await B.apply('editNotePopover', { id: 'danach', text: 'zweimal danach' });
    const second = B.logOps().find((o) => o.f && o.f.text === 'zweimal danach');
    const drift2 = Number(second.ts.slice(0, 13)) - Date.now();
    assert.ok(drift2 < 24 * HOUR, `the drift did not compound: ${Math.round(drift2 / HOUR)} h`);

    await B.relaunch();
    assert.equal(B.storeDiagnostics().quarantine, null,
      'and 23 h of drift is inside §7.1\'s window, so the next launch is ordinary');
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE PARK BOUNDARY AND THE RE-DERIVATION — THE BOARD PROJECTS EMPTY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · FAILED (HIGH) · an HLC above the park boundary empties the board at `init()`', () => {
  test('every spine op parks as `future`, `state` is empty, and the quarantine says the opposite', async () => {
    // THE MECHANISM. `store.init()` re-derives `board.json` into a spine on every launch, and on
    // a board that carries a lineage it does so with `restamp: true`, which mints each op at
    // `this._clock.tick()` — the HLC, not the wall clock. `oplog.append` classifies every op it
    // is given against `Date.now()`, and ADR 001 §7.4 parks anything more than
    // MAX_FUTURE_DRIFT_MS ahead. So an HLC above that boundary parks THE ENTIRE SPINE, and the
    // projection of a log whose every line is parked is an empty board.
    //
    // `store._clockSkew` cannot catch it: it walks the LOG's live ops, the register cells and the
    // checkpoint horizon — the three things §12.6 names — and the spine is none of those, because
    // it is built BEFORE the log is read.
    //
    // HOW THE HLC GETS THERE. Two inputs, both ordinary and both already in this file: §3's drag
    // puts it up to 24 h ahead of the wall clock from a peer op alone, and any BACKWARD step of
    // the machine clock (an NTP correction, a resume from sleep, a timezone-database repair) adds
    // the rest. Modelled here in its simplest form — one session on a machine 25 h fast — because
    // the mechanism is the HLC's value at `init()` and not how it got there.
    const f = await twoMacs();
    const A = f.device('A');
    await f.settle();

    await withWallClock(25 * HOUR, async () => {
      await A.apply('editNotePopover', { id: 'n1', text: 'zukunft' });
    });
    await A.close();
    const onDisk = A.boardText();
    assert.equal(JSON.parse(onDisk).notes.length, 2, 'the precondition: board.json is whole');

    await A.run(async () => {
      A.store.ready = false;
      A.store.listeners.clear();
      await A.store.init();

      assert.deepEqual(A.store.state.notes, [], 'THE FINDING: the board is EMPTY');
      assert.deepEqual(A.store.state.categories, [], 'categories too — everything');
      assert.ok(A.store._log.lines().every((l) => l.park === 'future'),
        'because every spine op was minted above the park boundary and parked');
      assert.equal(A.store.ready, true, 'and the launch reports itself as successful…');
      assert.equal(A.store.bootFailure, null, '…with no boot failure (I-2 does not fire)');
      assert.equal(A.store.quarantine.reason, 'reconcile-failed');
      assert.match(A.store.quarantine.detail, /board\.json was kept whole/,
        'and the detail says board.json was kept whole, which is true of the FILE and false of '
        + 'the state derived from it');
      assert.equal(A.boardText(), onDisk, 'the file itself is untouched at this instant');
    });

    // The file is untouched only until the next save. The autosave that follows any launch — the
    // one `tests/helpers/fleet.js` performs at `open()`, and the one `main.js` performs on the
    // first debounced write — commits the empty projection over it.
    await A.persist();
    assert.deepEqual(JSON.parse(A.boardText()).notes, [],
      'and one persist later the empty board IS board.json. Promise 4 — "a quarantine can never '
      + 'cost content" — has been overtaken at the step before the quarantine.');
  });

  test('SUCCEEDED (control) · 23 h of the same drift, and the board survives intact', async () => {
    // THE MUTATION CHECK: the boundary is the whole of it. Two hours less and the identical
    // sequence re-derives, reconciles and keeps every entry.
    const f = await twoMacs();
    const A = f.device('A');
    await f.settle();
    await withWallClock(23 * HOUR, async () => {
      await A.apply('editNotePopover', { id: 'n1', text: 'zukunft' });
    });
    await A.close();
    await A.run(async () => {
      A.store.ready = false;
      A.store.listeners.clear();
      await A.store.init();
      assert.equal(A.store.state.notes.length, 2, 'the board is whole');
      assert.equal(A.store.state.notes.find((n) => n.id === 'n1').text, 'zukunft');
      assert.equal(A.store._log.lines().filter((l) => l.park).length, 0, 'nothing parked');
      assert.equal(A.store.quarantine ?? null, null, 'and no quarantine at all');
    });
  });

  test('SUCCEEDED (control) · a REAL relaunch resets the HLC, which is why this needs an in-process `init()`', async () => {
    // The scope of §4, stated honestly. A new process builds a fresh clock at the wall clock, so
    // the spine is minted below the boundary and the board is fine. What §4 needs is a SECOND
    // `init()` inside one process, which `store.useIdentity()` itself advises ("Call store.init()
    // again — board.json is the truth and re-deriving from it costs nothing") and which any
    // mid-session family opt-in would perform.
    const f = await twoMacs();
    const A = f.device('A');
    await f.settle();
    await withWallClock(25 * HOUR, async () => {
      await A.apply('editNotePopover', { id: 'n1', text: 'zukunft' });
    });
    await A.close();
    const { createClock } = await import('../../src/js/core/stamp.js');
    A.store._clock = createClock(A.short, () => Date.now());
    await A.run(async () => {
      A.store.ready = false;
      A.store.listeners.clear();
      await A.store.init();
      assert.equal(A.store.state.notes.length, 2, 'a fresh HLC re-derives the board intact');
    });
  });
});
