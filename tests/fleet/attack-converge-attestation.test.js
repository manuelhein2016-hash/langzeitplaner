// FLEET · THE CONVERGENCE ADVERSARY — AN OP THAT ARRIVES BEFORE ITS ATTESTATION.
// FINDING F-6 · ADR 001 §4.0, §7.4 · ADR 002 §2.3, §5.2.5 · ADR 003 §8.2 · Risk R2.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RULE, AND WHY IT IS A CONVERGENCE RULE AND NOT AN AUTHORISATION ONE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > "An op that arrives before the attestation that resolves it (there is no causal delivery —
//   >  a partial pull or a fresh cursor makes this ordinary). It must PARK, NOT REJECT — a
//   >  rejection is final and final is data loss."
//
// E5 closed F-6 with a ladder of three rungs, and each rung is right on its own:
//
//   1. `store.applyRemote` PARKS a curable refusal (`notMyDevice`, `unattestedDevice`) under
//      `PARK_REASONS.ATTESTATION` instead of dropping it, and `oplog.load()` feeds the reason
//      back as `haveAttestation: false` so a relaunch cannot quietly promote it;
//   2. `sync/personal.js` DEFERS it and holds the cursor below it, so a quit before the cure
//      re-fetches rather than skips;
//   3. after `maxDeferrals` fruitless pulls it QUARANTINES the op and RELEASES THE CURSOR,
//      because ADR 003 §8.2 is explicit that "a permanently rejected op must never silently spin
//      forever".
//
// §1 and §2 show rungs 1 and 2 working. §3 is the finding: **rung 3 makes the hold permanent and
// invisible.** Once the cursor is released the relay's `since` filter will never serve the op
// again, so the parked line is the only copy — and the only thing that ever re-judges a parked
// line is `store.unparkAttested()`, whose single caller in the product is
// `src/js/family/mount.js:289`, on the adoption of a NEW peer. A launch whose peer list is
// already correct — every launch after the first — never calls it. The op stays parked for ever,
// `sync.status()` reports `healthy` on both Macs, and `store.warnings` (which has no consumer,
// F-8) is emptied by the next launch anyway.
//
// The M1 shape of this is not exotic. `member.set{dev.*}` is a FAMILY-space op kind, so a person
// with two Macs and no Familienkreis has nowhere in the log to record an attestation at all
// (`tests/helpers/fleet.js` S-1): the device set comes from PAIRING, i.e. from
// `localStorage`'s peers list, and any launch where that list has not yet been written — a
// restore, a cleared WebView store, a Tauri build where `family/engine.js`'s `localStorage` is
// the wrong slot — is a launch that refuses its own other Mac.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, simClock } from '../helpers/fleet.js';
import { MAX_DEFERRALS } from '../../src/js/sync/personal.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n1', date: '2027-03-04', text: 'Anfang', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/**
 * Make `dev` forget that its peer is one of its own Macs, and hand back the restorer.
 *
 * `store._peerDevices` is ADR 001 §4.0's "the LOCAL device set as PAIRING established it", and
 * `family/engine.js:141` fills it from `localStorage` at every start. Emptying it is exactly the
 * state of a Mac whose peers list has not been written yet — which is what a first pull after a
 * fresh install, a restore, or a Tauri build with the wrong storage slot looks like.
 */
function forgetPeers(dev) {
  const known = [...dev.store._peerDevices];
  dev.store._peerDevices = new Set();
  return () => { for (const d of known) dev.store._peerDevices.add(d); };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. PARK, NOT REJECT — AND THE CURE LANDS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · SUCCEEDED · the refusal is curable, so the op is held rather than lost', () => {
  test('parked under `attestation`, deferred by the engine, cursor held, cured by pairing', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    const restore = forgetPeers(A);

    await B.apply('editNotePopover', { id: 'n1', text: 'von B, vor der Attestierung' });
    await B.push();
    await A.pull();

    assert.equal(A.state.notes[0].text, 'Anfang', 'not applied — the gate held');
    assert.deepEqual(A.parked().map((l) => l.park), ['attestation'],
      'F-6 rung 1: PARKED, with the reason ADR 002 §5.2.5 requires');
    assert.deepEqual(A.deferredOps().map((d) => d.why), ['notMyDevice'],
      'F-6 rung 2: the engine is holding it, and names the refusal it is holding for');
    assert.equal(A.cursor(), '0',
      'and the cursor has NOT moved past it — the relay will serve it again');
    assert.deepEqual(A.quarantined(), [], 'nothing is refused terminally');

    // The cure: pairing widens the device set. `family/mount.js:286-289` is these two lines.
    restore();
    const cured = await A.run(() => A.store.unparkAttested());
    assert.equal(cured.length, 1, 'the held op is re-judged and admitted');
    assert.equal(A.state.notes[0].text, 'von B, vor der Attestierung');
    assert.equal(A.parked().length, 0);
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('SUCCEEDED · the hold survives a quit as STATE, not as a re-fetch', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    forgetPeers(A);
    await B.apply('editNotePopover', { id: 'n1', text: 'von B' });
    await B.push();
    await A.pull();

    await A.relaunch();
    assert.deepEqual(A.parked().map((l) => l.park), ['attestation'],
      '`oplog.load()` feeds the reason back through `classifyOp` as `haveAttestation:false`, so a '
      + 'relaunch does not promote it — which was the whole of E3-3');
    assert.equal(A.state.notes[0].text, 'Anfang', 'still not applied');
    assert.equal(A.cursor(), '0', 'and the cursor is still behind it, so it is still re-fetchable');
  });

  test('SUCCEEDED · a refusal NOTHING can cure is still a refusal, and never parks', async () => {
    // The other half of F-6's rule: `foreignSpace` / `localSpace` are verdicts about the op, and
    // parking them would be a way of keeping a stranger's write on disk for ever.
    const f = await twoMacs();
    const A = f.device('A');
    await f.settle();
    const before = A.parked().length;
    const r = A.store.applyRemote([
      { id: 'AAAAAAAAAAAAAAAAAAAAAA', k: 'pref.set', e: 'pref:x', space: 'local', act: A.memberId, dev: A.deviceId, ts: A.logOps()[0].ts, f: {} },
    ]);
    assert.deepEqual(r.refused.map((x) => x.reason), ['localSpace']);
    assert.equal(r.refused[0].parked, undefined, 'not parked');
    assert.equal(A.parked().length, before, 'and no line was kept');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE LADDER RUNS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · SUCCEEDED (as designed) · the deferral ladder releases the cursor after MAX_DEFERRALS', () => {
  test('five fruitless pulls, then a quarantine and a released cursor', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    forgetPeers(A);
    await B.apply('editNotePopover', { id: 'n1', text: 'von B' });
    await B.push();

    for (let i = 0; i <= MAX_DEFERRALS; i++) await A.pull();

    assert.deepEqual(A.quarantined().map((q) => q.reason),
      [`still notMyDevice after ${MAX_DEFERRALS} attempts`],
      'ADR 003 §8.2 — "a permanently rejected op must never silently spin forever"');
    assert.equal(A.deferredOps().length, 0, 'it is no longer deferred');
    assert.notEqual(A.cursor(), '0', 'and the cursor has been released past it');
    assert.equal(A.status().state, 'error', 'the indicator is lit — while this session lasts');
    assert.equal(A.status().errorKind, 'quarantine');
    assert.deepEqual(A.parked().map((l) => l.park), ['attestation'],
      'the LINE is still parked, so the op itself is not lost');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE FINDING — THE PARK HAS NO REAPER
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · FAILED · after the ladder, nothing ever re-judges the held op again', () => {
  test('a permanent single-op divergence with `healthy` on both Macs and no warning left', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    const restore = forgetPeers(A);

    await B.apply('editNotePopover', { id: 'n1', text: 'Termin abgesagt' });
    await B.push();
    for (let i = 0; i <= MAX_DEFERRALS; i++) await A.pull();
    assert.equal(A.quarantined().length, 1, 'the ladder has run and the cursor is released');

    // THE NEXT LAUNCH. `family/engine.js:141` supplies `peerDeviceIds` from the peers list, so by
    // now the device set is CORRECT — modelled directly, because `dev.open()` skips
    // `useIdentity()` once the identity is durable, exactly as a real relaunch does.
    await A.relaunch();
    restore();
    await A.catchUp();
    await f.settle();

    assert.deepEqual(A.parked().map((l) => l.park), ['attestation'],
      'the op is still held — and nothing on any launch path re-judges a parked line. '
      + '`store.useIdentity()` does not call `unparkAttested()`; nor does `store.init()`; '
      + "`family/mount.js:289` does, but only when a NEW peer is adopted, which this launch is not.");
    assert.equal(A.state.notes[0].text, 'Anfang', 'so the cancellation never lands');
    assert.equal(B.state.notes[0].text, 'Termin abgesagt');
    assert.equal(boardsAgree([A, B]).equal, false, 'a permanent divergence');

    assert.deepEqual([A.status().state, B.status().state], ['healthy', 'healthy'],
      'and the engine\'s `quarantined` map died with the old session, so §2\'s `error` indicator '
      + 'is gone: the ONE place that knew is a per-session Map.');
    assert.deepEqual(A.warnings(), [],
      'and `store.warnings` is emptied by the launch, so the last record of it is gone too');

    // It is still RECOVERABLE — which is what makes this a missing call and not a lost op.
    const cured = await A.run(() => A.store.unparkAttested());
    assert.deepEqual(cured.length, 1,
      'ONE explicit `store.unparkAttested()` fixes it. THE FINDING IS THAT NOTHING CALLS IT. If '
      + 'this ever needs no such call, invert this test rather than deleting it.');
    assert.equal(A.state.notes[0].text, 'Termin abgesagt');
    await A.persist();
    await f.settle();
    await f.settle();
    assert.equal(boardsAgree([A, B]).equal, true, boardsAgree([A, B]).detail);
  });

  test('SUCCEEDED · re-pulling a held op does not duplicate its line or grow the log', async () => {
    // The other thing a hold could get wrong: the op is offered again on every pull and enters
    // `applyRemote` a second time, where it is folded ALONGSIDE the parked copy of itself
    // (`[...this._log.ops({includeParked:true}), ...wellFormed]`). It must stay one line.
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    forgetPeers(A);
    await B.apply('editNotePopover', { id: 'n1', text: 'von B' });
    await B.push();

    await A.pull();
    const lines = A.logOps({ includeParked: true }).length;
    for (let i = 0; i < 4; i++) await A.pull();
    assert.equal(A.parked().length, 1, 'one parked line, however many times it is re-delivered');
    assert.equal(A.logOps({ includeParked: true }).length, lines, 'and the log does not grow');
  });
});
