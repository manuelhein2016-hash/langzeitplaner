// FLEET · ROUND 8 ADVERSARY — THE PARK PATH, AFTER P-8. ROUND 9 CLOSED TWO OF ITS THREE ROWS.
// ADR 002 §5.2.1, §5.2.5 · ADR 003 §4, §8.2 · `src/js/sync/personal.js` `PARK_HANDLING`
// · `src/js/sync/outbox.js` `createParkingLot` · `src/js/sync/status.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RULE P-8 WROTE DOWN, AND THE THREE INPUTS THAT BROKE IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > THE RULE, WITH NO EXCEPTIONS: **a park is a deferral and it may never become a drop.**
//                                                    — `sync/personal.js`, `PARK_HANDLING`
//
// The round-8 fix is genuinely a domain rather than a branch: `PARK_HANDLING` is keyed off
// `ENVELOPE_PARK`, `parkHandlingOf()` is total, an unknown reason from a newer build is still a
// park, and the envelopes are retained on disk. Every one of those held under attack.
//
// What did not hold was the SENTENCE. Three inputs turned a park back into a drop, and none of
// them needed a hostile relay:
//
//   §1  the LADDER. `maxDeferrals` is 5. A `curedBy: 'session'` park whose cure has not arrived
//       after five pulls — ~4 minutes at ADR 003 §8.2's 45 s visible cadence — is quarantined,
//       RELEASED FROM THE LOT, and the cursor is moved past it. For a P1 attestation park there
//       is no second copy: the op was never decrypted, so the store never parked a line.
//   §2  a FAILED DISK WRITE. `createParkingLot.park()` called `persist()` and ignored its return
//       value, so a lot that could not write still answered `true`. `pullNow` treats `true` as
//       "retained", the `curedBy: 'update'` class is then marked DORMANT and the cursor is
//       released — over an envelope that exists only in RAM.
//   §3  a RELAUNCH. `loadLot()` runs inside `pullNow()`, so between a launch and its first pull
//       `deferred` is empty, and `store.diagnostics().sync.parked` counts `_log.parkedOps()` —
//       the LOG's park, never the lot's. `judgeSyncStatus` therefore returns `silent: true`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT ROUND 9 CHANGED, AND WHERE THE FIXES LANDED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Both closed rows were fixed inside `createParkingLot`, which is the layer that OWNS the bytes.
// Neither was fixed by removing the ladder: round 8's mutant M-B already proved that reddens the
// withhold defence, and ADR 003 §8.2 requires a bound on a hold. What changed is what the end of
// a hold is allowed to do to the only copy of an op.
//
//   §1 → CLOSED. `release()` is now the APPLIED path and the only path in the file that destroys
//        bytes, and it destroys them only where the lot has no evidence against it. An oid the
//        caller PARKED OR TOUCHED since its last release is one it has just said it still cannot
//        open, so releasing it in the same breath is a ladder giving up — those are SHELVED:
//        retained on disk, out of the replay set so nothing spins, and put back by the next fresh
//        process, which is exactly when a new binary, key epoch or attestation can have arrived.
//        `refuse()` is the same transition said out loud, and is what `terminal()` should call.
//        The residual error direction is the point: the guard can only ever retain an envelope it
//        could have destroyed, never destroy one it should have kept.
//   §2 → CLOSED. `park()` RETURNS THE WRITE'S VERDICT. `pullNow`'s `if (!kept) holds.set(…)` was
//        correct, documented and unreachable; it now fires, and an unwritable park is the stall
//        its own docblock always claimed it was.
//   §3 → STILL OPEN, and not in this package's files. `loadLot()`'s laziness is
//        `sync/personal.js`'s and `sync.parked`'s derivation is `src/js/store.js`'s. The row below
//        is unchanged and still asserts the defect.
//
// §1–§3 are the adversary's rows. §4 holds the controls, §5 the durability matrix, and §6 is new:
// the lot's own contract, minimised, so the two closures above have a row that dies if either
// mechanism is reverted rather than only an end-to-end row that dies for many reasons.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, simClock, MINUTE } from '../helpers/fleet.js';
import { MAX_DEFERRALS, PARK_HANDLING } from '../../src/js/sync/personal.js';
import { createParkingLot, memoryRecordStore, PARK_REVIVALS } from '../../src/js/sync/outbox.js';
import { ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';
import { b64u } from '../../src/js/core/b64.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n1', date: '2027-03-04', text: 'Zahnarzt 14:30', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/** Serve every row to `victim` under an envelope version this build does not know. */
const asVersion2 = (victim) => (res, req, who) => {
  if (who !== victim.short || req.method !== 'GET' || req.path !== '/api/v1/ops' || res.status !== 200) return res;
  return { ...res, body: { ...res.body, ops: (res.body.ops || []).map((o) => ({ ...o, v: 2 })) } };
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · CLOSED — R8-4. THE LADDER STILL ENDS THE HOLD; IT NO LONGER DESTROYS THE ONLY COPY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `defer()`'s ladder is required by ADR 003 §8.2 — "a permanently rejected op must never silently
// spin forever" — and it is exempted for the DORMANT class only. For `curedBy: 'session'` it ends
// in `terminal()`, which quarantines the oid, pushes it to `toRelease`, and lets the cursor past.
// ALL OF THAT IS UNCHANGED, and deliberately: the ladder is a bound on a hold, the quarantine is
// the loud record ADR 003 §8.2 requires, and round 8's mutant M-B measured what happens when the
// cursor hold is simply deleted instead.
//
// What is no longer true is the sentence that made it a data loss. `personal.js` argued the
// terminal was survivable because "the STORE parked the line independently" — true for a REFUSAL
// out of `applyRemote` (the op was decrypted and `oplog.park()` holds a line), FALSE for the two
// `openOp` parks, which happen BEFORE the decrypt: at P1 (no attestation) and P4 (no epoch key)
// there is no op, no line, and after `lot.release()` there was no envelope either.
//
// The lot now separates the two cases by the caller's own words — see §6, which minimises it —
// so this row measures the consequence: the same five-pull fuse, the same quarantine, the same
// released cursor, and the entry ARRIVES anyway on the first launch after the cure.
//
// The input is not exotic. `tests/helpers/fleet.js` S-1 records that at M1 the attestation hop
// HAS NO WIRE: neither the log (a `member.set` op needs an `fsp_` space) nor the relay
// (`handlers/members.js` refuses to be the authority) can deliver one, so pairing is the only
// route. A pairing that has not finished — or a second Mac adopted while the first is asleep — is
// exactly five pulls away from ending the hold, and that is now a deferral to the next launch
// rather than a permanent divergence.

describe('§1 · CLOSED · the ladder ends the hold and KEEPS the envelope', () => {
  test('five pulls without an attestation, and the entry still arrives after the cure', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    const attA = f.attestations.get(A.short);
    f.attestations.delete(A.short);                    // the attestation hop has not landed yet
    await A.apply('createNotePopover', { id: 'absage', date: '2027-06-07', text: 'Mama sagt ab', categoryId: 'c1' });
    await A.push();

    const before = B.cursor();
    for (let i = 0; i < MAX_DEFERRALS; i++) {
      f.clock.advance(MINUTE);
      await B.pull();
      assert.equal((await B.heldEnvelopes()).length, 1, `pull ${i}: still HELD, durably — this half works`);
      assert.equal(B.cursor(), before, `pull ${i}: and the cursor is held below it, as W1 requires`);
      // R8-1 IS CLOSED AND THIS LINE IS ITS WITNESS FROM THE PARK SIDE. Round 8 measured `error`
      // from the second pull on, because the held page was re-served and the raw `verifyChain`
      // read its own advanced anchor as a hole. `pullNow` uses the chain WITNESS now, whose
      // `fresh` filter drops rows at or below the head, so a re-served hold is not a fork.
      assert.equal(B.status().state, 'pending',
        `pull ${i}: a hold is work outstanding, and it is still only that — not a fork (R8-1)`);
    }

    f.clock.advance(MINUTE);
    await B.pull();                                    // the sixth
    assert.deepEqual(await B.heldEnvelopes(), [],
      'the hold has ENDED — the ladder is a bound and ADR 003 §8.2 requires one');
    assert.equal(B.quarantined().length, 1, 'it is a quarantine, loudly');
    assert.notEqual(B.cursor(), before, 'and the cursor has been released past it');
    // ── THE CLOSURE, IN ONE FIELD ────────────────────────────────────────────────────────────
    // The envelope is not in the replay set and it is not gone. It is SHELVED: on the disk this
    // Mac just wrote, with its reason, its seq and its refusal count.
    assert.equal(B.diagnostics().park.refused, 1,
      'the ladder gave up and the lot KEPT the bytes — `release()` shelves what the caller has '
      + 'just told it it could not open');
    const disk = JSON.parse(B.disk.getItem('langzeitplaner.parked'));
    assert.equal(disk.length, 1, 'and it is on the DISK, not in a Map that dies with the process');
    assert.equal(disk[0].refused, true);
    assert.equal(disk[0].reason, ENVELOPE_PARK.ATTESTATION, 'with the reason it was held for');

    // The cure arrives. Within this session it cures nothing, and that is ADR 003 §8.2 holding:
    // a shelved envelope is not replayed, so nothing spins and no pull is spent on it.
    f.attestations.set(A.short, attA);
    await B.catchUp();
    assert.equal(B.state.notes.some((n) => n.id === 'absage'), false,
      'not within this session — the hold ended, and re-opening the same bytes with the same '
      + 'world is exactly what the ladder exists to stop');

    // THE RELAUNCH. A fresh process is the one moment a new binary, a newly fetched key epoch or
    // a newly arrived attestation can exist, so it is the moment the shelf is re-judged.
    await B.close();
    await B.open();
    await B.catchUp();
    assert.equal(B.state.notes.some((n) => n.id === 'absage'), true,
      'INVERTED (R8-4): the attestation arrived, the app was restarted, and the entry is HERE. '
      + 'Round 8 measured it permanently absent, with the cursor past it and the only copy '
      + 'deleted. A park is a deferral and it may never become a drop — including at the end of '
      + 'the ladder.');
    assert.equal(A.state.notes.some((n) => n.id === 'absage'), true, 'and still on the Mac that wrote it');
    assert.equal(B.diagnostics().park.revived, 1, 'the launch says which envelope it put back');

    // ── AND IT GOES QUIET AGAIN, WHICH IS THE HALF THAT WAS MISSING ─────────────────────────
    //
    // INVERTED by the round-9 integration pass. This row used to assert `refused === 1` after the
    // cure and carried a note saying so: L-1's durable ledger recorded the refusal and never
    // retracted it, so this Mac kept saying `error` about a divergence that had healed. That is
    // round 8's own failure — `healthy` while wrong — with the sign flipped, and an indicator that
    // cannot go out is one nobody reads.
    //
    // `store.retractSyncRefusal(applied)` closes it, and only the STORE's own `applied` list can
    // call it: a relay cannot clear its own verdict without making the op actually apply, which is
    // the cure. The ledger is still durable and still records every refusal that stays refused —
    // §5's matrix and `sync-domains` S4 are the controls for that. Mutant **M-I**.
    assert.equal(B.storeDiagnostics().sync.refused, 0,
      'the refusal is WITHDRAWN once the revived envelope opens — the divergence it recorded has '
      + 'healed, and a durable ledger that cannot retract is a permanently red indicator');
    assert.equal(B.quarantined().length, 0,
      'and the session agrees with the disk: the quarantine entry is gone too');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · CLOSED — R8-5. AN UNWRITABLE PARK IS A STALL, WHICH IS WHAT ITS DOCBLOCK ALWAYS SAID
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The lot's own docblock is the strongest statement in the file:
//
//   > **RETURNS `false` AT THE CAP, AND THE CALLER MUST NOT ADVANCE THE CURSOR PAST IT.** …
//   > A stalled sync is a bad afternoon; a moved cursor is a missing appointment nobody will ever
//   > know about.
//
// and `pullNow` honours it: `if (!kept) holds.set(p.seq, …)`, with a `catch` around the call and
// the comment "an unwritable park is a stall". The catch was unreachable. `park()` did
// `rows.push(…); await persist(); return true;` and `persist()` swallowed the throw itself,
// warned, and returned `false` — a value nobody read. The defence existed, was documented, was
// called correctly by its caller, and could not fire.
//
// `park()` now returns the write's verdict, so the same input takes the OTHER branch of the same
// `if`, which is why this closure needed no new seam and no new field.

describe('§2 · CLOSED · a park that did not reach the disk holds the cursor', () => {
  test('the cursor stops below an envelope that was never written, and nothing is lost', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    // A full disk / a refused quota, on exactly the parking-lot slot. Everything else still writes.
    const realSet = B.disk.setItem.bind(B.disk);
    B.disk.setItem = (k, v) => {
      if (k === 'langzeitplaner.parked') throw new Error('QuotaExceededError');
      return realSet(k, v);
    };

    await A.apply('createNotePopover', { id: 'neuartig', date: '2027-06-07', text: 'aus einem neueren Build', categoryId: 'c1' });
    await A.push();
    const before = B.cursor();

    f.wire.hostile.onResponse = asVersion2(B);
    await B.pull();
    f.wire.honest();

    assert.equal(B.deferredOps()[0]?.why, ENVELOPE_PARK.VERSION, 'the version gate parked it');
    assert.equal(PARK_HANDLING[ENVELOPE_PARK.VERSION].curedBy, 'update',
      'and ADR 003 §8.2 forbids pinning the cursor behind an op only a new binary can read — '
      + 'which is why the release is gated on the lot having actually KEPT the bytes');
    assert.equal(B.cursor(), before,
      'INVERTED (R8-5): the cursor is HELD. The lot said the write did not land, `pullNow` put the '
      + 'seq into `holds`, and the relay is still the durable copy (ADR 006 §9.1 W1). Round 8 '
      + 'measured it released, over an envelope that existed only in RAM.');
    assert.equal(B.diagnostics().park.unwritable, 1, 'and the lot counts the write that failed');
    assert.match(B.warnings().join(' '), /could not be persisted/, 'and says so in words');
    const s0 = B.status();
    assert.equal(s0.state, 'pending', 'a stall is work outstanding, not a fault of the family\'s');
    assert.equal(s0.silent, false, 'and 19.3\'s promise is not claimed while a pull cannot finish');

    await B.close();
    await B.open();
    assert.deepEqual(await B.heldEnvelopes(), [],
      'the envelope really is not on the disk — the write really did fail; that half was never '
      + 'in question. What changed is that nothing was CONSUMED on the strength of it.');
    await B.catchUp();
    assert.equal(B.state.notes.some((n) => n.id === 'neuartig'), true,
      'INVERTED (R8-5): and the entry arrives. `since` is still below its seq, so the relay serves '
      + 'it again — which is the whole reason a stall is the right answer to a failed write.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · SUCCEEDED — R8-6. A DURABLY HELD OP IS INVISIBLE UNTIL THE FIRST PULL OF A SESSION
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠ HALF CLOSED BY THE ROUND-9 INTEGRATION PASS, AND HALF STILL OPEN. The two halves are:
//
//   (a) `sync/personal.js` — `attach()` did not read the durable park at all, so between a launch
//       and its first successful pull the engine had no idea it was holding anything. **CLOSED.**
//       `attach()` now starts `loadLot()` and RE-EMITS the status when it lands. It cannot
//       `await`: `attach()` is called synchronously from the mount and returns `detach`, and an
//       async `attach` would move a `store.subscribe` behind a microtask. It does not have to,
//       because `family/mount.js:78` wires `onStatus: () => refreshSyncChrome()` — the toolbar is
//       PUSH-fed, so a fact the engine learns one microtask after launch reaches the user. That
//       is what the second row below measures, and mutant **M-M** kills it.
//   (b) `src/js/store.js` — `sync.parked` is `_log.parkedOps().length`, the LOG's park, which can
//       never count the lot's. **STILL OPEN**, still not this package's file, and it is why the
//       SYNCHRONOUS poll in the first row below still lies. `sync/status.js` cannot help from
//       where it stands: the field EXISTS and answers `0`, so `blindSpots()` has nothing to catch.
//
// The first row is unchanged and still asserts the defect, so it goes red the day (b) lands.
//
// L-2 was "nothing could see a held op". The fix made `status()` read `deferred.size` and gave
// `store.diagnostics().sync` a `parked` field. Neither reaches the parking lot at a launch:
//
//   · `deferred` is seeded by `loadLot()`, which is called from `pullNow()` and from
//     `heldEnvelopes()` and from nowhere else. `attach()` calls `emitStatus()` immediately, and
//     the chrome reads `status()` on launch, both BEFORE any pull;
//   · `sync.parked` is `this._log.parkedOps().length` — the LOG's park, which holds ops this
//     device DECRYPTED and would not apply. A P1/P4/version park never became an op, so it is not
//     there and cannot be.
//
// The result is not "unknown", which `blindSpots()` would catch. It is an affirmative `silent`.

describe('§3 · HALF CLOSED · on launch, a Mac holding somebody\'s appointment', () => {
  test('`silent: true`, with the envelope on the disk it just read', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'gehalten', date: '2027-06-07', text: 'gehalten', categoryId: 'c1' });
    await A.push();
    await B.pull();
    assert.equal(B.status().state, 'pending', 'while the session is warm the hold is visible');

    await B.close();
    await B.open();
    const s = B.status();                              // the launch reading — before any pull
    assert.equal(JSON.parse(B.disk.getItem('langzeitplaner.parked')).length, 1,
      'the envelope is on the disk this launch just opened');
    assert.equal(B.storeDiagnostics().sync.parked, 0,
      'DEFECT: `sync.parked` counts the LOG\'s parked lines and can never count the lot\'s');
    assert.equal(s.state, 'healthy', 'DEFECT: `healthy` at the moment the chrome reads the state');
    assert.deepEqual(s.blind, [],
      'DEFECT: and not even BLIND — the field exists and answers 0, so `blindSpots()` is empty '
      + 'and the "I have not looked" escape hatch `sync/status.js` built is bypassed');
    assert.equal(s.silent, true,
      'DEFECT: `silent: true` — 19.3\'s promise asserted as a boolean, and false');
    assert.equal((await B.heldEnvelopes()).length, 1,
      'and the same object answers correctly the moment somebody calls the OTHER method');
  });

  // ── HALF (a), CLOSED — WHAT THE CHROME ACTUALLY SEES ─────────────────────────────────────
  //
  // The row above polls `status()` synchronously at the instant of launch, and that is not how
  // the product reads it: `family/mount.js:78` is `onStatus: () => refreshSyncChrome()`. So the
  // question that decides whether a user is misinformed is not "what does a synchronous poll
  // return" but "what does the engine PUSH, and when". Before round 9 the answer was: one
  // `healthy` at attach, and then nothing until a pull succeeded — which on a Mac that opens its
  // lid in a tunnel is never. Now `attach()` starts the durable read and pushes the corrected
  // state the moment it lands, with no pull, no network and no timer.
  test('CLOSED (R8-6a) · attach() reads the durable park and re-emits, with no pull at all', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'gehalten', date: '2027-06-07', text: 'gehalten', categoryId: 'c1' });
    await A.push();
    await B.pull();
    assert.equal(JSON.parse(B.disk.getItem('langzeitplaner.parked')).length, 1, 'the envelope is retained');

    await B.close();
    await B.open();
    B.offline();                      // NO NETWORK. Whatever is learned here is learned from disk.
    const detach = B.attach();
    // One microtask is not enough — `loadLot()` awaits two async ports (the lot and the cursors).
    for (let i = 0; i < 8; i++) await Promise.resolve();
    detach();

    const pushed = B.statuses;
    assert.ok(pushed.length >= 2,
      'attach() pushed a SECOND status after reading the disk. Round 8 pushed exactly one, at '
      + 'attach time, and then nothing until a pull succeeded — which on a Mac with no network is '
      + 'never, so a held appointment was invisible for the whole launch.');
    const last = pushed[pushed.length - 1];
    assert.equal(last.state, 'pending',
      'and what it pushed is the truth: this Mac is holding somebody\'s appointment');
    assert.equal(last.silent, false,
      '19.3\'s promise as a boolean — quiet MEANS there is nothing to tell you, and there is');
    assert.equal(last.deferredOps, 1, 'with the count the settings sheet reads');
    assert.equal(B.diagnostics().pulls, 0,
      'AND NOT ONE PULL HAPPENED. This is read off the disk the launch already opened, so it is '
      + 'true in a tunnel, on a plane, and before the first poll interval has elapsed.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · FAILED — the park domain held under every input this file could find
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · FAILED · what P-8 got right', () => {
  test('the table is total, and the `update` class is genuinely durable when the disk works', async () => {
    assert.deepEqual(Object.keys(PARK_HANDLING).sort(), Object.values(ENVELOPE_PARK).sort(),
      'the handling table is keyed off the ENUM, so a seventh reason cannot be silently omitted');
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    await A.apply('createNotePopover', { id: 'v2', date: '2027-06-07', text: 'v2', categoryId: 'c1' });
    await A.push();
    f.wire.hostile.onResponse = asVersion2(B);
    await B.pull();
    f.wire.honest();
    const held = await B.heldEnvelopes();
    assert.equal(held.length, 1, 'retained');
    assert.equal(held[0].reason, ENVELOPE_PARK.VERSION);
    await B.close();
    await B.open();
    assert.equal((await B.heldEnvelopes()).length, 1,
      'and a fresh process reads it back with its reason — this is the half P-8 built and it works');
    // The ladder does NOT run on a dormant hold, which is the other half ADR 003 §4 needs.
    for (let i = 0; i < MAX_DEFERRALS + 3; i++) { f.clock.advance(MINUTE); await B.pull(); }
    assert.equal((await B.heldEnvelopes()).length, 1,
      'ten pulls later it is still held, not quarantined — "an old client degrades to DOES NOT '
      + 'SHOW the new thing instead of LOSES the new thing" (ADR 003 §4)');
    assert.deepEqual(B.quarantined(), []);
  });

  test('a `session` park holds the cursor below itself, which is what makes §1 a fuse and not a rule', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'p', date: '2027-06-07', text: 'p', categoryId: 'c1' });
    await A.push();
    const before = B.cursor();
    await B.pull();
    assert.equal(B.cursor(), before, 'W1 on the receiving side: the relay is still the durable copy');
    assert.equal(B.status().state, 'pending', 'and it is `pending`, not `error` — a hold is not a fault');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE DURABILITY MATRIX AND THE OTHER TWO RELAUNCH HAZARDS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · the durability matrix, probed at the two arms round 8 left open', () => {
  // ── FAILED. E5-2's stand-down is SELF-LIMITING, and the loss is reported. ──────────────────
  //
  // `_outboxHorizonCap()` state 1 — "the persisted horizon already folds an op the server has not
  // acknowledged" — returns `undefined`, i.e. no cap at all, which is the arm that made E5-2
  // reachable twice. The attack is: reach it once (a checkpoint written by a build without the
  // cap, modelled here by folding past the floor by hand) and see whether the device is now a
  // device that loses EVERY subsequent unacknowledged op.
  //
  // It is not. The folded op leaves the outbox with its line, so the floor rises to the next
  // unacknowledged op, which is above the horizon, and the cap is imposed again on the very next
  // persist. One op is lost, exactly one, and `sync.lost` derives the FACT off the disk.
  test('FAILED · one legacy fold does not turn the Mac into one that folds for ever', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    A.offline();
    await A.apply('createNotePopover', { id: 'off1', date: '2027-06-07', text: 'offline eins', categoryId: 'c1' });
    assert.equal(A.outboxSize(), 1);
    await A.run(async () => {
      // A checkpoint from a build without the cap: fold past the outbox floor.
      const live = A.store._log.ops().map((o) => o.ts).sort();
      A.store._log.compact({ horizon: live[live.length - 1] });
      await A.store.persistNow();
    });
    assert.equal(A.outboxSize(), 0, 'the line is gone — this is E5-2, reached deliberately');
    assert.equal(A.storeDiagnostics().sync.lost, 1, 'and `sync.lost` derives the fact off the disk');

    await A.apply('createNotePopover', { id: 'off2', date: '2027-06-08', text: 'offline zwei', categoryId: 'c1' });
    await A.persist();
    assert.equal(A.outboxSize(), 1, 'the NEXT op keeps its line — the cap is imposed again');
    assert.equal(A.storeDiagnostics().sync.lost, 1, 'and nothing else was lost');
    await A.relaunch();
    assert.equal(A.outboxSize(), 1, 'across a relaunch');
    assert.equal(A.status().state, 'error', 'with the loss reported, which is S4-lost working');
    A.online();
    await f.settle(3);
    assert.equal(B.state.notes.some((n) => n.id === 'off2'), true, 'and the later op does reach B');
    assert.equal(B.state.notes.some((n) => n.id === 'off1'), false,
      'the folded one never can — that is the accepted, REPORTED cost, not a new defect');
  });

  // ── SUCCEEDED. R8-8. A LOG QUARANTINE ERASES THE REFUSAL LEDGER AND IS NOT ITSELF A ROW. ───
  //
  // `_restoreSyncLedger` is called only with the checkpoint that was ADOPTED, and its docblock
  // argues that correctly: a quarantined log's checkpoint is bytes this launch has just refused
  // to believe. What is not argued is what takes its place. `SYNC_OBSERVABLES` has no row for
  // `diagnostics().quarantine` — the state in which the app has decided it cannot trust its own
  // history — so the only thing keeping the fold off `healthy` is `store.warnings`, and that row
  // is deliberately `state: healthy`.
  test('SUCCEEDED · a quarantined log takes the durable refusal record with it', async () => {
    const f = await twoMacs();
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'x', date: '2027-06-07', text: 'x', categoryId: 'c1' });
    await A.push();
    for (let i = 0; i < MAX_DEFERRALS + 2; i++) { f.clock.advance(MINUTE); await B.pull(); }
    assert.equal(B.storeDiagnostics().sync.refused, 1, 'L-1: the refusal is on disk');
    assert.equal(B.status().state, 'error');

    await B.close();
    B.disk.setItem('langzeitplaner.checkpoint', '{"not":"a checkpoint"}');
    await B.open();
    assert.equal(B.storeDiagnostics().quarantine === null, false, 'the log is quarantined');
    assert.equal(B.storeDiagnostics().sync.refused, 0,
      'DEFECT: and the permanent divergence L-1 exists to remember went with it');
    // ── R8-8 · HALF CLOSED, AND THE HALVES ARE IN DIFFERENT FILES ─────────────────────────
    //
    // CLOSED: `SYNC_OBSERVABLES` now has a `quarantine` row, so the fold SEES the state in which
    // the app has decided it cannot trust its own history, and `silent` is false because of SHARP
    // evidence rather than because somebody happened to write a sentence into the mixed
    // `warnings` prose channel. That last clause was the finding's own complaint.
    const s = B.status();
    assert.ok(s.observables.some((o) => o.id === 'quarantine'),
      'INVERTED (R8-8): the fold names the quarantine. Round 8 measured `SYNC_OBSERVABLES` with '
      + 'no row for it at all.');
    assert.equal(s.silent, false, 'and 19.3\'s promise is not claimed over a refused history');
    assert.deepEqual([...s.blind], [],
      'and it is a row that can be ANSWERED — a store that stopped publishing `quarantine` would '
      + 'now show up as a blind spot instead of as silence');
    //
    // DELIBERATELY NOT `error`, and this is the control the row is written against: ADR 006 §9.3
    // makes a quarantine "a VISIBLE, REPORTED, CONVERGING event, never a quiet one", and
    // `attack-converge-rejoin.test.js` §2 pins "the INDICATOR stays quiet, deliberately" for the
    // §9.3 re-join, which reaches this exact state. Making the row `error` was measured turning
    // that control red — round 8's opposite failure, a fix that reports a fault for ever.
    assert.notEqual(s.state, 'error',
      'the indicator does not escalate to a FAULT for a converging quarantine — see '
      + '`sync/status.js`\'s `quarantine` row before changing this. (It reads `pending` here and '
      + 'not `healthy` because ADR 006 §9.3\'s re-join re-publishes the board, so the outbox is '
      + 'non-empty — which is `S4-pending`, the control, doing its job.)');
    //
    // STILL OPEN, and it is the LOUD half: the erased ledger above. `store.js` restores
    // `syncRefusals` only from the checkpoint it ADOPTED, so a quarantine takes a permanent
    // divergence record with it and `sync.refused` reads 0 over a divergence that is still real.
    // The honest signal is `diagnostics().quarantine` saying WHAT the quarantine discarded; with
    // that field the row above can be `error` for a launch that threw evidence away and stay
    // quiet for a re-join that threw nothing away. Owner: `src/js/store.js`.
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE LOT'S OWN CONTRACT — the two closures above, minimised
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1 and §2 are end-to-end and therefore die for many reasons. These rows die for exactly one
// each, so a revert is legible as a revert:
//
//   · `park()` returns the write's verdict         — revert it and `§6.1` dies (and §2 with it)
//   · `release()` shelves what was just parked     — revert it and `§6.2` dies (and §1 with it)
//   · a fresh process revives the shelf, bounded   — revert it and `§6.3`/`§6.4` die
//
// Pure: no fleet, no relay, no clock but the one passed in. `sync/outbox.js` is I/O-free by
// construction (ADR 005 §2) and this is that property being useful.

const SPACE = 'psp_9xQ2mR7bL0aZ4tV8wKQ1rT';
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const sealed = (over = {}) => ({
  v: 1, sp: SPACE, ep: 1, dv: '7QAR2MZ9XKPNC0GV', oid: b64u(rnd(16)), wit: '',
  iv: b64u(rnd(12)), ct: b64u(rnd(48)), sig: b64u(rnd(64)), ...over,
});

/** A record store whose disk can be made to refuse, and whose contents a test can read back. */
function disk(initial = []) {
  let held = JSON.parse(JSON.stringify(initial));
  const s = {
    durable: true,
    refuse: false,
    async loadRecords() { return JSON.parse(JSON.stringify(held)); },
    async saveRecords(list) {
      if (s.refuse) throw new Error('QuotaExceededError');
      held = JSON.parse(JSON.stringify(list));
    },
    peek() { return JSON.parse(JSON.stringify(held)); },
  };
  return s;
}

describe('§6 · the parking lot may not lose an envelope, and may not lie about keeping one', () => {
  test('§6.1 · `park()` answers `false` when the write did not land — R8-5', async () => {
    const d = disk();
    const lot = createParkingLot({ storage: d });
    await lot.load();
    assert.equal(await lot.park(SPACE, sealed(), '1', 'attestation'), true, 'a write that lands is `true`');

    d.refuse = true;
    const warns = [];
    const stalling = createParkingLot({ storage: d, warn: (m) => warns.push(m) });
    await stalling.load();
    assert.equal(await stalling.park(SPACE, sealed(), '2', 'attestation'), false,
      'THE ROW: a park that could not be written is `false`, which is the one word `pullNow` '
      + 'reads to decide whether to hold the cursor. Round 8 measured `true`.');
    assert.equal(stalling.diagnostics().unwritable >= 1, true, 'and the lot counts it');
    assert.match(warns.join(' '), /could not be persisted/);

    // The RE-PARK branch answers the same way — R8-5 was in both exits of `park()`, and a re-park
    // is what every pull does to an envelope it still cannot open.
    const d2 = disk();
    const again = createParkingLot({ storage: d2 });
    await again.load();
    const e = sealed();
    assert.equal(await again.park(SPACE, e, '3', 'attestation'), true);
    d2.refuse = true;
    assert.equal(await again.park(SPACE, e, '3', 'epoch'), false,
      're-parking an envelope already held is a write too, and it reports the same way');
  });

  test('§6.2 · `release()` destroys what OPENED and shelves what the caller just parked — R8-4', async () => {
    const d = disk();
    const lot = createParkingLot({ storage: d });
    await lot.load();
    const opened = sealed();
    const stuck = sealed();
    await lot.park(SPACE, opened, '1', 'attestation');
    await lot.park(SPACE, stuck, '2', 'attestation');

    // THE CURE LANDING. `pullNow` releases an applied op WITHOUT having parked it in that pull:
    // it opened, `applyRemote` took it, and the log is the durable copy now. A fresh lot models
    // the pull boundary the way the engine crosses it — the marks do not outlive a release.
    const cured = createParkingLot({ storage: d });
    await cured.load();
    assert.equal(await cured.release(SPACE, [opened.oid]), 1);
    assert.equal(cured.diagnostics().parked, 1, 'it left the replay set');
    assert.equal(cured.diagnostics().refused, 0,
      'and it was DESTROYED, which is correct: the op is in the log, and keeping ciphertext for '
      + 'an op that landed is retention for its own sake');
    assert.equal(d.peek().length, 1, 'the disk agrees');

    // THE LADDER GIVING UP. The engine flushes `toPark` — telling the lot, in the same pull, that
    // it still could not open this one — and THEN releases it out of `terminal()`.
    assert.equal(await cured.park(SPACE, stuck, '2', 'attestation'), true);
    assert.equal(await cured.release(SPACE, [stuck.oid]), 1, 'it leaves the replay set either way');
    assert.equal(cured.diagnostics().parked, 0);
    assert.equal(cured.diagnostics().refused, 1,
      'THE ROW: and it was SHELVED, not destroyed. Round 8 measured `release()` deleting the only '
      + 'copy of an op the relay will never serve again.');
    assert.equal(d.peek().length, 1, 'the bytes are on the disk');
    assert.equal(d.peek()[0].refused, true, 'marked as what they are');
    assert.equal(cured.shelved(SPACE)[0].oid, stuck.oid, 'and handed back whole');

    // `refuse()` is the same transition asked for out loud — what `terminal()` should call.
    const said = createParkingLot({ storage: disk() });
    await said.load();
    const e = sealed();
    await said.park(SPACE, e, '9', 'attestation');
    assert.equal(await said.refuse(SPACE, [e.oid], 'still attestation after 5 attempts'), 1);
    assert.deepEqual(said.parked(SPACE), [], 'out of the replay set');
    assert.equal(said.shelved(SPACE)[0].reason, 'still attestation after 5 attempts', 'with its reason');
  });

  // ── §6.2b · WHY `terminal()` CALLS `refuse()` AND NOT `release()`, MADE MEASURABLE ────────
  //
  // `release()`'s guard works by INFERENCE: it retains an oid the caller has parked or touched
  // SINCE ITS LAST RELEASE, which in `pullNow` is true only because `toPark` is flushed before
  // anything is released. That coupling is invisible at the two flush sites and would break
  // silently if they were ever swapped — and the failure would be a park becoming a drop, which
  // is the whole of R8-4.
  //
  // Round 9's `terminal()` calls `refuse()`, and this row is the difference stated as behaviour
  // rather than as a preference: given a lot that has NO `unopened` memory of an oid — a fresh
  // process, or a release earlier in the same pull, both of which clear it — `release()` destroys
  // and `refuse()` keeps. Mutant **M-K** swaps the call back; it survives on today's flush order,
  // which is exactly why the difference needs a row of its own rather than an end-to-end one.
  test('§6.2b · with no `unopened` memory, release() DESTROYS and refuse() KEEPS', async () => {
    const mk = async () => {
      const d = disk();
      const lot = createParkingLot({ storage: d });
      await lot.load();
      const e = sealed();
      await lot.park(SPACE, e, '7', 'attestation');
      // THE STATE THE COUPLING DEPENDS ON. `release()` clears `unopened` as a side effect, so a
      // second release in the same pull — or the first release of a fresh process that read the
      // shelf back off the disk — meets an envelope it has no memory of parking.
      await lot.release(SPACE, ['some-other-op-that-is-not-here']);
      return { d, lot, e };
    };

    const a = await mk();
    assert.equal(await a.lot.release(SPACE, [a.e.oid]), 1, 'release() takes it out of the replay set');
    assert.deepEqual(a.lot.shelved(SPACE), [],
      'AND DESTROYS IT. The guard is gone: the lot no longer remembers that the caller said it '
      + 'could not open this one, so `release()` does what its name says.');
    assert.deepEqual(a.d.peek(), [], 'nothing on the disk — the only copy this Mac could reach');

    const b = await mk();
    assert.equal(await b.lot.refuse(SPACE, [b.e.oid]), 1, 'refuse() takes it out of the replay set too');
    assert.equal(b.lot.shelved(SPACE).length, 1,
      'AND KEEPS IT, unconditionally, because it does not infer anything — the caller SAID this '
      + 'was a hold that ended without the op opening. That is why `terminal()` calls this one.');
    assert.equal(b.d.peek()[0].refused, true, 'on the disk, marked, ready for the next launch');
  });

  test('§6.3 · a fresh process puts the shelf back — and only a fresh process does', async () => {
    const d = disk();
    const lot = createParkingLot({ storage: d });
    await lot.load();
    const e = sealed();
    await lot.park(SPACE, e, '4', 'attestation');
    await lot.refuse(SPACE, [e.oid]);
    assert.deepEqual(lot.parked(SPACE), [],
      'nothing spins: ADR 003 §8.2 forbids a hold that retries for ever, and a shelved envelope '
      + 'costs this session no pull at all');

    const relaunched = createParkingLot({ storage: d });
    assert.equal(await relaunched.load(), 1);
    assert.equal(relaunched.parked(SPACE)[0].oid, e.oid,
      'THE ROW: a relaunch is the one moment a new binary, a new key epoch or a new attestation '
      + 'can exist, so it is the moment the shelf is re-judged');
    assert.equal(relaunched.parked(SPACE)[0].tries, 0, 'with the ladder it burned in the old world reset');
    assert.equal(relaunched.diagnostics().revived, 1, 'and the launch says so');
    assert.equal(relaunched.diagnostics().refused, 0);
  });

  test('§6.4 · the revival is BOUNDED, and past the bound the bytes are still there', async () => {
    const d = disk();
    const e = sealed();
    for (let launch = 0; launch <= PARK_REVIVALS; launch++) {
      const lot = createParkingLot({ storage: d });
      await lot.load();
      if (launch === 0) await lot.park(SPACE, e, '5', 'attestation');
      assert.equal(lot.parked(SPACE).length, 1, `launch ${launch}: replayed`);
      await lot.refuse(SPACE, [e.oid]);
    }
    const done = createParkingLot({ storage: d });
    await done.load();
    assert.deepEqual(done.parked(SPACE), [],
      `after ${PARK_REVIVALS} revivals it is no longer replayed — "must never silently spin `
      + 'forever" is a statement about the long run, and a launch is part of the long run');
    assert.equal(done.diagnostics().refused, 1, 'AND IT IS NOT A DROP: the envelope is still held');
    assert.equal(done.shelved(SPACE)[0].env.ct, e.ct, 'byte for byte');
  });

  test('§6.5 · the cap still counts the replay set, so a shelved envelope cannot wedge a space', async () => {
    // The cap exists so a relay serving undecryptable envelopes cannot fill the disk, and its
    // answer AT the cap is to refuse and stall (§4 above, and `sync-queue.test.js` §4). A shelf
    // entry is not work outstanding, so it does not consume that budget — otherwise one ladder
    // burn-out would permanently shrink the lot.
    const lot = createParkingLot({ storage: memoryRecordStore(), cap: 2 });
    await lot.load();
    const a = sealed();
    await lot.park(SPACE, a, '1', 'attestation');
    await lot.park(SPACE, sealed(), '2', 'attestation');
    assert.equal(await lot.park(SPACE, sealed(), '3', 'attestation'), false, 'full, and it says so');
    await lot.refuse(SPACE, [a.oid]);
    assert.equal(await lot.park(SPACE, sealed(), '3', 'attestation'), true,
      'the shelf does not eat the cap');
    assert.equal(lot.diagnostics().refused, 1, 'and the shelved one is still counted, and still kept');
  });
});
