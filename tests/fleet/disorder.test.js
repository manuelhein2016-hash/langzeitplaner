// FLEET · LZP-505 — CONVERGENCE UNDER ARBITRARY DISORDER.
//
// ADR 003 §3.3 makes one claim and stakes the whole protocol on it:
//
//   > "`seq` is a transport cursor and never a merge input. No merge outcome anywhere depends on
//   >  it. A server that assigns out of stamp order, re-delivers, or delays cannot cause
//   >  divergence — only latency. This is the single most valuable simplification in the
//   >  protocol, and it is what makes story 19.6 reduce to 'a large op set arrives late'."
//
// `tests/fleet/fleet-harness.test.js` §2a drives four HAND-PICKED disorders at it. This file
// drives an ENUMERATED one instead: a seeded schedule that reorders, duplicates, splits into
// pages, interleaves two authors and partitions a device, replayed over 24 seeds, with three
// invariants asserted every time:
//
//   INV-A  the two Macs' `board.json` agree byte for byte;
//   INV-B  NOTHING WAS LOST AND NOTHING ARRIVED TWICE — the surviving entity set is exactly the
//          set the script created, minus what the script deleted, computed from the script and
//          not from either Mac. This is the invariant a self-comparison cannot give you: two
//          Macs that both dropped the same op agree perfectly.
//   INV-C  the result is STABLE — syncing again changes nothing (ADR 001 §6's idempotent fold).
//
// **WHAT IS DELIBERATELY *NOT* ASSERTED, and why it would be wrong to:** the winner of a field
// contest. `store._clock` is built on the real `Date.now()` (`core/stamp.js` takes the clock as a
// port, but `store.js` binds it to the wall clock), so two edits a simulated hour apart can be
// microseconds apart in real time, and which of two devices wins a same-millisecond tie is a
// property of the RUN, not of the protocol. INV-A already pins the only thing that matters about
// it — that both Macs pick the SAME winner. A test that also demanded a particular winner would
// be asserting the scheduler.
//
// Zero dependencies: the schedule comes from `seededRandom`, so a red run names the seed and is
// reproducible by hand.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, registerDigest, MUTATORS, chainMutators, simClock, HOUR } from '../helpers/fleet.js';
import { seededRandom } from '../helpers/loopback.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2027-03-04', text: 'Anfang', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b0', startDate: '2027-07-01', endDate: '2027-07-14', label: 'Urlaub', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

/**
 * A deterministic script of edits, as DATA rather than as code, so the honest run and the hostile
 * run are literally the same input. Each step names the device that performs it.
 *
 * The five kinds are chosen to cover the join lattice rather than to look busy: two creates on
 * different devices (a set union), two writes to ONE field from different devices (the only true
 * conflict), a delete (a tombstone, the thing that can un-delete), a bar edit (a second entity
 * kind) and a scratchpad write (a map rather than a list).
 */
function script(seed, steps = 14) {
  const rand = seededRandom(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const out = [];
  for (let i = 0; i < steps; i++) {
    const who = pick(['A', 'B']);
    const kind = pick(['create', 'contest', 'bar', 'pad', 'delete']);
    out.push({ who, kind, i });
  }
  // A contest is only interesting if the entity exists and both Macs touch it, so one is forced.
  out.push({ who: 'A', kind: 'contest', i: steps });
  out.push({ who: 'B', kind: 'contest', i: steps + 1 });
  return out;
}

async function perform(f, step) {
  const d = f.device(step.who);
  switch (step.kind) {
    case 'create':
      return d.apply('createNotePopover', {
        id: `${step.who}${step.i}`, date: '2027-05-05', text: `${step.who} ${step.i}`, categoryId: 'c1',
      });
    case 'contest':
      return d.apply('editNotePopover', { id: 'n0', text: `${step.who} schrieb ${step.i}` });
    case 'bar':
      return d.apply('editBarLabel', { id: 'b0', label: `${step.who}-${step.i}` });
    case 'pad':
      return d.apply('padBlur', { month: '2027-05', text: `${step.who} ${step.i}` });
    case 'delete':
      return d.apply('deleteNotePopover', { id: 'n0' });
    default:
      throw new Error(`unknown step ${step.kind}`);
  }
}

/** Run one script over one fleet, syncing according to `plan`. */
async function run(f, steps, plan) {
  for (const step of steps) {
    f.clock.advance(HOUR);
    await perform(f, step);
    if (plan.syncEvery && step.i % plan.syncEvery === 0) {
      for (const d of f.all) if (!d.isOffline) await d.sync();
    }
    if (plan.partitionAt === step.i) f.B.offline();
    if (plan.healAt === step.i) f.B.online();
  }
  f.B.online();
  await f.settle(4);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE PROPERTY
// ═════════════════════════════════════════════════════════════════════════════

describe('§1 · 24 seeded schedules, each replayed honest and hostile', () => {
  for (let seed = 1; seed <= 24; seed++) {
    test(`seed ${seed}: reorder + duplicate + paging + a partition lose nothing`, async () => {
      const steps = script(seed);
      const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock: simClock() });
      f.wire.hostile.onResponse = chainMutators(
        MUTATORS.shuffleOps(seed),
        MUTATORS.duplicateOps(),
        seed % 2 === 0 ? MUTATORS.reverseOps() : ((res) => res),
      );
      await run(f, steps, { syncEvery: 2, partitionAt: 4, healAt: 9 });
      f.wire.honest();
      await f.settle(3);

      // INV-A — the two Macs agree, byte for byte, including on every contest.
      const agree = boardsAgree([f.A, f.B]);
      assert.equal(agree.equal, true, `seed ${seed}: INV-A — the two Macs disagree (${agree.detail})`);

      // INV-B — the surviving set, computed from the SCRIPT.
      const expected = new Set(steps.filter((x) => x.kind === 'create').map((x) => `${x.who}${x.i}`));
      if (!steps.some((x) => x.kind === 'delete')) expected.add('n0');
      assert.deepEqual(
        f.A.state.notes.map((n) => n.id).sort(),
        [...expected].sort(),
        `seed ${seed}: INV-B — an entry was lost, duplicated or resurrected`,
      );

      // INV-C — folding it all again changes nothing (ADR 001 §6).
      const stable = f.A.boardContent();
      await f.settle(2);
      assert.deepEqual(f.A.boardContent(), stable, `seed ${seed}: INV-C — a second sync moved the board`);
      assert.deepEqual(f.B.boardContent(), stable);

      for (const d of f.all) {
        assert.deepEqual(d.quarantined(), [], `seed ${seed}: ${d.name} quarantined something`);
      }
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THREE DEVICES — because two can hide an asymmetry
// ═════════════════════════════════════════════════════════════════════════════

describe('§2 · three Macs, one member', () => {
  test('a third device joins the same member and all three converge', async () => {
    // M1 is two Macs, but the harness is LZP-1005's foundation and a fleet of two cannot show an
    // asymmetry: with two devices "A told B" and "B told A" are the only edges. With three, an op
    // has to reach a Mac that never spoke to its author directly, which is the first thing that
    // breaks when a cursor or an ack is per-peer rather than per-space.
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C'], clock: simClock() });
    assert.equal(await f.assertDistinctIdentities(), true);
    assert.equal(new Set(f.all.map((d) => d.memberId)).size, 1, 'one person, three Macs');

    await f.device('A').apply('createNotePopover', { id: 'vonA', date: '2027-06-01', text: 'A', categoryId: 'c1' });
    await f.device('A').push();
    await f.device('B').sync();                       // B hears it from the relay …
    await f.device('B').apply('editNotePopover', { id: 'vonA', text: 'A, dann B' });
    await f.device('B').push();
    await f.settle();

    for (const d of f.all) {
      assert.equal(d.state.notes.find((n) => n.id === 'vonA').text, 'A, dann B',
        `${d.name} did not converge`);
    }
    const a = boardsAgree(f.all);
    assert.equal(a.equal, true, a.detail);
    assert.deepEqual(registerDigest(f.device('A')), registerDigest(f.device('C')),
      'and C — which never spoke to A directly — holds the identical registers');
  });

  test('two of three offline, all three editing, then everybody comes back', async () => {
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C'], clock: simClock() });
    await f.settle();
    f.device('B').offline();
    f.device('C').offline();
    for (let i = 0; i < 4; i++) {
      f.clock.advance(HOUR);
      for (const name of ['A', 'B', 'C']) {
        await f.device(name).apply('createNotePopover', {
          id: `${name}${i}`, date: '2027-06-02', text: `${name}${i}`, categoryId: 'c1',
        });
      }
    }
    f.device('B').online();
    f.device('C').online();
    await f.settle(4);

    const ids = (d) => d.state.notes.map((n) => n.id).sort();
    assert.equal(ids(f.device('A')).length, 1 + 12, 'nothing was lost on any of the three');
    assert.deepEqual(ids(f.device('B')), ids(f.device('A')));
    assert.deepEqual(ids(f.device('C')), ids(f.device('A')));
    const a = boardsAgree(f.all);
    assert.equal(a.equal, true, a.detail);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PAGING — the cursor under a limit the client did not choose
// ═════════════════════════════════════════════════════════════════════════════

describe('§3 · a page is not a batch', () => {
  test('a catch-up that spans many pages loses nothing and doubles nothing', async () => {
    // The relay clamps `limit` to `opsPerPull` and may return fewer than asked for at any time.
    // The invariant is the one `tests/server/ops.test.js` states from the server's side, asserted
    // here from the CLIENT's: the union of every page equals the whole log, each seq exactly once.
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock: simClock() });
    await f.settle();
    f.device('B').offline();
    for (let i = 0; i < 40; i++) {
      f.clock.advance(HOUR);
      await f.device('A').apply('createNotePopover', {
        id: `p${i}`, date: '2027-07-07', text: `Seite ${i}`, categoryId: 'c1',
      });
    }
    await f.device('A').push();

    // The relay is honest but STINGY: one op per page, so the catch-up is 40 round trips.
    f.wire.hostile.onResponse = (res, req) => {
      if (!(req.method === 'GET' && req.path === '/api/v1/ops' && res.status === 200)) return res;
      const ops = res.body.ops.slice(0, 1);
      return {
        ...res,
        body: {
          ...res.body,
          ops,
          nextCursor: ops.length ? ops[ops.length - 1].seq : String(req.query.since || '0'),
          hasMore: res.body.ops.length > 1,
        },
      };
    };
    f.device('B').online();
    await f.device('B').catchUp(10);
    f.wire.honest();
    await f.device('B').sync();

    for (let i = 0; i < 40; i++) {
      assert.equal(f.device('B').state.notes.find((n) => n.id === `p${i}`).text, `Seite ${i}`,
        `p${i} was lost to paging`);
    }
    assert.equal(f.device('B').state.notes.length, 41, 'and nothing arrived twice');
    assert.equal(boardsAgree([f.device('A'), f.device('B')]).equal, true);
  });
});
