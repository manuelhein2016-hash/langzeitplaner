// FLEET · ROUND 10 — THE E6 GATE. BOTH DIRECTIONS, AND E6'S ACTUAL SHAPE.
// ADR 002 §5.4, §8.6 · ADR 003 §4, §4.1, §6.3, §8.2 · `src/js/sync/personal.js` · `chain.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHAT IT IS NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 10's adversary returned NO-GO for E6 and gave a reason worth quoting, because it is the
// reason this file is shaped the way it is:
//
//   > The blocker is that E6's threat model is the one this engine cannot currently serve. The
//   > personal engine's adversary is a relay lying to ONE device about ONE person's log; the fork
//   > detector was built for that.
//
// Every OTHER row in this suite measures one mechanism against one input. Those rows are the
// reason to believe the parts work. **They are not the reason to believe E6 can be built**, and
// the difference is the whole point of this file: a suite of green unit rows is a claim that each
// defence works in the arrangement its author imagined, and E6's arrangement is one that no
// author here has imagined — four devices, three PEOPLE, and a membership that changes while the
// network is broken.
//
// So this file does three things and deliberately nothing else:
//
//   §1  THE HONEST DIRECTION, four ways. An honest relay repeating itself, a held page re-served,
//       a member purge, and a first pull from genesis. Every one of them must be QUIET — no
//       `error`, no accusation in the warning channel, and the cursor MOVING. A detector that is
//       merely silent while stuck has not passed; `cursorMoved` is asserted separately every time.
//   §2  THE HOSTILE DIRECTION. A real fork is caught, and STAYS caught across a relaunch — which
//       is the half that was open until this round and is the reason §2b can be written at all.
//   §3  E6's SHAPE, over the real handlers: four devices, three members, a JOIN into a circle that
//       already has a removal in its history, a removal during a PARTITION, and two removals
//       RACING. These are not attacks. They are Tuesday in a family, and what this file reports
//       is what the sync engine actually does in each — including where the answer is "it cannot
//       tell, and says so", which is a result and not a failure.
//
// ⚠ THE HOUSE RULE THIS FILE OBEYS. A row that would pass on a build with the detector switched
// OFF is not evidence, and §1 is exactly that shape of row — every one of its four inputs is
// satisfied by silence. So each of the four carries a CONTROL in the same arrangement proving the
// detector was live and could have fired. Without those controls this whole section is a
// tautology, and it is how the first draft of §1c fooled itself.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFleet, createRelay, joinNewMember, MUTATORS, simClock, MINUTE,
} from '../helpers/fleet.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAIN_FINDINGS } from '../../src/js/sync/chain.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n1', date: '2027-03-04', text: 'Zahnarzt 14:30', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const findings = (dev) => (dev.storeDiagnostics().sync.chain?.findings || []);
const said = (dev) => dev.warnings().join(' ¶ ');
/** The two sentences `noteChain` can put in front of a user. Neither may appear on an honest relay. */
const CRIED_WOLF = /does not add up|no longer check the server's record/;
const logOf = async (f) => (await f.relay.store.listOps(f.spaceId, 0n, 100000)).ops;

/**
 * The full quiet reading of one Mac. Every field a "was it quiet?" claim could hide in.
 *
 * `cursor` is here because SILENCE IS NOT THE REQUIREMENT — a Mac wedged at seq 4 for ever is
 * perfectly quiet and completely broken, and that is the exact failure round 8 shipped and round 9
 * had to undo. Every honest-direction row below asserts the cursor MOVED.
 */
const reading = (dev) => ({
  state: dev.status().state,
  chain: dev.storeDiagnostics().sync.chain === null ? null : findings(dev).map((f) => f.kind),
  criedWolf: CRIED_WOLF.test(said(dev)),
  cursor: dev.cursor(),
  refused: dev.storeDiagnostics().sync.refused,
});

/**
 * THE READING THE MULTI-MEMBER ROWS USE, AND WHY IT IS NOT `state`.
 *
 * §3's rows put a SECOND PERSON in the space, and the space the fleet mints is a PERSONAL one
 * (`psp_…`). `core/authz.js` refuses another member's op there with `notMyAct` — correctly, and
 * that refusal is 21.2 holding, not a defect. It also drives `status().state` to `error` for a
 * reason that has nothing to do with the chain, so reading `state` in those rows would measure
 * the gate rather than the question.
 *
 * What §3 asks is the SYNC question: does this Mac allege a fork, does it say so to its user, and
 * does its cursor move? Those three are exactly the fields below. The refusal is not ignored — §4
 * asserts it, by name, as the gate itself.
 */
const syncReading = (dev) => ({
  chain: dev.storeDiagnostics().sync.chain === null ? null : findings(dev).map((f) => f.kind),
  criedWolf: CRIED_WOLF.test(said(dev)),
  cursor: dev.cursor(),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE HONEST DIRECTION — four shapes an honest relay produces, and all four must be QUIET
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · an honest relay, four ways, and the cursor moving through all of them', () => {
  test('§1a · a relay REPEATING ITSELF is not a fork, and the repeat does not clear a verdict', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle(2);
    await A.apply('createNotePopover', { id: 'r1', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();

    // Six polls over the same page. An idle family produces exactly this all day.
    for (let i = 0; i < 6; i++) {
      clock.advance(MINUTE * 10);
      await B.pull();
      const r = reading(B);
      assert.equal(r.state, 'healthy', `poll ${i}: an idle poll is not an error`);
      assert.equal(r.chain, null, `poll ${i}: and nothing is written into the verdict`);
      assert.equal(r.criedWolf, false, `poll ${i}: and not one word of it to the user`);
    }
    assert.equal(B.state.notes.some((n) => n.id === 'r1'), true,
      'NON-VACUITY: the entry actually arrived, so the quiet is the quiet of a Mac that is up to '
      + 'date and not of one that never received anything');

    // THE CONTROL, in the same fleet: the detector is live and the re-serve is not what silences it.
    clock.advance(MINUTE);
    await A.apply('createNotePopover', { id: 'r2', date: '2027-05-02', text: 'zwei', categoryId: 'c1' });
    await A.push();
    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();
    assert.equal(B.status().state, 'error',
      'CONTROL: one rewritten chain value on the very next page IS caught. Without this line §1a '
      + 'is satisfied by a build whose detector never runs at all.');
  });

  test('§1b · a HELD page re-served is quiet, and the cursor moves once the hold is cured', async () => {
    // F-6's first contact: the op arrives before the attestation that would let it be opened, the
    // cursor is held below it (W1), and the honest relay serves THE SAME PAGE again because the
    // cursor did not move. Round 8 read that re-serve as a fork.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle(2);
    const attestation = f.attestations.get(A.short);
    f.attestations.delete(A.short);                    // the pairing has not finished yet

    await A.apply('createNotePopover', { id: 'h1', date: '2027-05-01', text: 'gehalten', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    const held = B.cursor();
    for (let i = 0; i < 4; i++) {
      clock.advance(MINUTE * 10);
      await B.pull();
      assert.equal(B.status().state !== 'error', true, `re-serve ${i}: a hold is not a fault`);
      assert.equal(CRIED_WOLF.test(said(B)), false, `re-serve ${i}: and nobody is accused`);
      assert.deepEqual(findings(B), [], `re-serve ${i}: and no finding is manufactured`);
    }
    assert.equal(B.cursor(), held,
      'NON-VACUITY: the cursor really is HELD — which is what makes the re-serve happen at all, '
      + 'and what makes the four quiet polls above worth asserting');

    // THE CURE. The pairing lands, and the cursor must then MOVE — silence while stuck is the
    // failure, not the requirement.
    f.attestations.set(A.short, attestation);
    clock.advance(MINUTE * 10);
    await B.pull();
    await B.pull();
    assert.notEqual(B.cursor(), held, 'THE ROW: the hold ended and the cursor moved');
    assert.equal(B.state.notes.some((n) => n.id === 'h1'), true, 'and the entry landed');
    assert.equal(reading(B).state, 'healthy', 'on a Mac with nothing left to report');
  });

  test('§1c · a MEMBER PURGE costs one pull, and nobody is wedged or accused', async () => {
    // ADR 003 §6.3, story 20.2. `seq` is gapless per space, so a legitimate removal is
    // indistinguishable at the client from a relay withholding rows — R10-4, measured field by
    // field in `round9-witness.test.js` §4a. R8-2's bound is what makes it survivable: the hold
    // lasts ONE honest round trip, not for ever.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle(2);
    const O = await joinNewMember(f, { name: 'O', colorRef: 'blau' });

    for (let i = 0; i < 3; i++) {
      await A.apply('createNotePopover', { id: `pa${i}`, date: `2027-05-0${i + 1}`, text: `Papa ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
      await O.apply('createNotePopover', { id: `po${i}`, date: `2027-06-0${i + 1}`, text: `Oma ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await O.push();
    }
    clock.advance(MINUTE * 10);
    await B.sync();
    const beforeCursor = B.cursor();
    const relayBefore = await logOf(f);
    assert.ok(relayBefore.some((o) => o.deviceShort === O.short),
      'NON-VACUITY: her ops are really in the log, so the hole the removal tears is a real hole. '
      + '(B never APPLIED them — see §4: this is a personal space and `notMyAct` is correct. What '
      + 'B has to survive is the gap in the SEQ COUNTER, which is the sync question and is real.)');

    const res = await A.run(() => A.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: f.spaceId, memberId: O.memberId,
    }));
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.purgedOps > 0, 'NON-VACUITY: the handler really deleted op rows');

    // A's board is written to AFTER the purge, so there is something above the hole to reach.
    await A.apply('createNotePopover', { id: 'nachher', date: '2027-07-01', text: 'nach dem Purge', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    clock.advance(MINUTE * 10);
    await B.sync();
    clock.advance(MINUTE * 10);
    await B.sync();

    const r = syncReading(B);
    assert.equal(r.chain, null,
      'THE ROW: a legitimate removal alleges NOTHING. It is the one destructive operation the '
      + 'product has, and a red light nobody can clear is what `chain.js`\'s header forbids.');
    assert.equal(r.criedWolf, false, 'and the user is not told the relay is lying to her');
    assert.notEqual(r.cursor, beforeCursor, 'and the cursor moved — quiet-because-wedged is not a pass');
    assert.equal(B.state.notes.some((n) => n.id === 'nachher'), true,
      'and everything ABOVE the hole arrived, which is the wedge R8-2 closed');

    // THE CONTROL: the same Mac, past the same purge, still catches a real lie.
    await A.apply('createNotePopover', { id: 'spaeter', date: '2027-07-02', text: 'später', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();
    assert.equal(B.status().state, 'error',
      'CONTROL: verification RESUMED past the purge. Detection is degraded from provable-from-'
      + 'genesis to provable-since-the-last-anchor, which is the honest ceiling — and not silence.');
  });

  test('§1d · a FIRST PULL FROM GENESIS is quiet, on the pull E6 makes most often', async () => {
    // Every new Mac and every restored backup starts at `since = 0`, and in E6 so does every new
    // member. Round 10 found this was the least-defended pull in the product; `round9-witness`
    // §2b closed the defence. This is the other direction: with an HONEST relay it must cost
    // nothing.
    //
    // The joiner here is a SECOND DEVICE OF THE SAME PERSON, not a second member, and that is
    // deliberate: a second MEMBER's genesis pull runs into `notMyAct` (§4 — this is a personal
    // space, and the refusal is 21.2 holding) which would turn this row into a measurement of the
    // gate rather than of the pull. The multi-member genesis pull is §3a, where the gate is named.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const base = createRelay().limits;
    const relay = createRelay({ clock, limits: { ...base, opsPerPull: 2 } });
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock, relay });
    const A = f.device('A');
    const B = f.device('B');

    // B never pulls, so its first pull really is from zero — across three pages.
    for (let i = 0; i < 5; i++) {
      await A.apply('createNotePopover', { id: `g${i}`, date: `2027-05-0${i + 1}`, text: `g${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
    }
    assert.equal(B.cursor(), '0', 'NON-VACUITY: B really does start at genesis');
    assert.ok((await logOf(f)).length > 2,
      'and the log is longer than one page, so page two has to be asked for');

    for (let i = 0; i < 6; i++) {
      clock.advance(MINUTE * 10);
      await B.sync();
    }
    const r = reading(B);
    assert.equal(r.state, 'healthy', 'THE ROW: a first pull from genesis is quiet');
    assert.equal(r.chain, null, 'and writes nothing into the verdict');
    assert.equal(r.criedWolf, false, 'and accuses nobody');
    assert.notEqual(r.cursor, '0', 'and the cursor MOVED off genesis');
    for (let i = 0; i < 5; i++) {
      assert.equal(B.state.notes.some((n) => n.id === `g${i}`), true, `and g${i} arrived — all five`);
    }

    // THE CONTROL: this is the pull where a withhold is hardest to see, so prove it is seen.
    // A fresh Mac makes the same genesis pull with the HEAD OF THE LOG withheld.
    // Its own clock AND its own relay built from that clock — a relay whose clock has run on
    // without the fleet's answers `401 stale_request`, which is the auth window doing its job.
    const clock2 = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f2 = await createFleet({
      board: BOARD(), devices: ['A', 'B'], clock: clock2,
      relay: createRelay({ clock: clock2, limits: { ...base, opsPerPull: 2 } }),
    });
    const A2 = f2.device('A');
    const B2 = f2.device('B');
    for (let i = 0; i < 3; i++) {
      await A2.apply('createNotePopover', { id: `w${i}`, date: `2027-05-0${i + 1}`, text: `w${i}`, categoryId: 'c1' });
      clock2.advance(MINUTE);
      await A2.push();
    }
    const first = (await logOf(f2))[0];
    f2.wire.hostile.onResponse = MUTATORS.withholdOps((o) => String(o.seq) === String(first.seq));
    clock2.advance(MINUTE * 10);
    await B2.pull();
    assert.equal(B2.status().state, 'error',
      'CONTROL: withhold the FIRST row of the log from a device pulling from genesis and it IS '
      + 'caught. The break lands on row zero, where there is no `prevSeq` for §3.3\'s gapless rule '
      + 'to be violated against, so it arrives as a MISMATCH carrying no `from` — the shape that '
      + 'held nothing at all until R10-2b. Without this line §1d passes on a build with no '
      + 'genesis-page defence whatsoever.');
    f2.wire.honest();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE HOSTILE DIRECTION — caught, and STILL caught after the quit
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · a real fork is caught, and stays caught across a relaunch', () => {
  test('§2a · the verdict outlives the quit, and is withdrawn only by evidence', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle(2);
    await A.apply('createNotePopover', { id: 'f1', date: '2027-05-01', text: 'eins', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();

    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();                                   // ONE lie, then honesty for ever
    assert.equal(B.status().state, 'error', 'caught while it is live');
    assert.equal(findings(B).some((x) => x.kind === CHAIN_FINDINGS.MISMATCH), true, 'and named');

    // THE QUIT — which is what a person does when the indicator goes red.
    await B.close();
    await B.open();
    const cold = reading(B);
    assert.equal(cold.state, 'error',
      'THE ROW: a fresh process, before its first pull, still says so. Until the round-10 '
      + 'integration pass this read `healthy` — `store.syncChain` is declared `durable: true` in '
      + '`sync/status.js` and rode in no file, so the only thing that could speak up again was a '
      + 'successful pull FROM THE RELAY THE ACCUSATION IS ABOUT.');
    assert.ok(cold.chain && cold.chain.includes(CHAIN_FINDINGS.MISMATCH),
      'carrying the finding that was made, so a detail pane can say WHAT and not only THAT');

    // AND IT IS WITHDRAWABLE. An honest relay with NEW rows takes it away again; without this the
    // durability fix trades a silent Mac for a permanently red one.
    await A.apply('createNotePopover', { id: 'f2', date: '2027-05-02', text: 'zwei', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    clock.advance(MINUTE * 10);
    await f.settle(3);
    assert.equal(B.storeDiagnostics().sync.chain, null, 'a REPORT, not a ratchet');
    assert.equal(B.status().state, 'healthy', 'and the indicator goes out');
    assert.equal(B.state.notes.some((n) => n.id === 'f2'), true, 'on a Mac that really caught up');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · E6's ACTUAL SHAPE — four devices, three members, and a membership that changes
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Nothing in this section is an attack. Every input is a family using the product.

describe('§3 · E6 · four devices, three members, and membership changing underneath', () => {
  test('§3a · a JOIN into a circle that ALREADY has a removal in its history', async () => {
    // ADR 003 §4.1's case, driven rather than argued: the joiner's very first pull crosses a hole
    // that predates her, and the specification is that she cannot prove a baseline and must say so.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const base = createRelay().limits;
    const relay = createRelay({ clock, limits: { ...base, opsPerPull: 2 } });
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock, relay });
    const A = f.device('A');
    await f.settle(2);

    const O = await joinNewMember(f, { name: 'O', colorRef: 'blau' });
    for (let i = 0; i < 3; i++) {
      await A.apply('createNotePopover', { id: `ja${i}`, date: `2027-05-0${i + 1}`, text: `A ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
      await O.apply('createNotePopover', { id: `jo${i}`, date: `2027-06-0${i + 1}`, text: `O ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await O.push();
    }
    const rm = await A.run(() => A.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: f.spaceId, memberId: O.memberId,
    }));
    assert.equal(rm.status, 200, JSON.stringify(rm.json));
    assert.ok(rm.json.purgedOps > 0, 'NON-VACUITY: the hole in the history is real');
    await A.apply('createNotePopover', { id: 'nachO', date: '2027-07-01', text: 'nach O', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();

    // SHE ARRIVES NOW, into a space whose log has a hole she can never account for.
    const N = await joinNewMember(f, { name: 'N', colorRef: 'rot' });
    assert.equal(N.cursor(), '0', 'she starts at genesis, like every joiner');
    for (let i = 0; i < 8; i++) {
      clock.advance(MINUTE * 10);
      await N.sync();
    }

    const r = syncReading(N);
    // ── R10-11 · THE RESULT, AND IT IS A FINDING RATHER THAN A PASS ─────────────────────────
    //
    // She is NOT wedged — her cursor reaches the head and every entry above the hole arrives —
    // and she alleges no fork. But she finishes her catch-up carrying a live `gap` verdict, and
    // it does not go away by pulling: measured over fourteen further rounds it is still `gap@7`,
    // because the only thing that clears a verdict is POSITIVE EVIDENCE (`foldedFresh` — the head
    // MOVED) and her head is already at the top of the log. Nothing is owed, nothing is broken,
    // and the indicator is red.
    //
    // WHY IT IS BOUNDED, AND WHY THE BOUND IS NOT COMFORT: the next entry ANYBODY in the family
    // writes moves the head and takes the verdict away — measured below. So the window is "until
    // someone writes", which for an active family is minutes and for a quiet one is days. It is
    // the new member's FIRST DAY, and round 10 made it worse in one specific way: `syncChain` now
    // rides in the checkpoint, so quitting no longer clears it either.
    //
    // IT IS R10-2 SEEN FROM THE OTHER SIDE. `personal.js` records why `chainOwed.size === 0`
    // cannot ship — a purge's debt can never be discharged — and this is the same asymmetry
    // already present without that clause: for a device whose head is at the log's top, the
    // clearing condition is unreachable until the family acts.
    const head = String((await logOf(f)).at(-1).seq);
    assert.notEqual(r.cursor, '0', 'she is not wedged at genesis — her cursor moved');
    assert.equal(r.cursor, head,
      'and it reached the HEAD of the log: she walked the whole space, hole and all, and stopped '
      + 'where there was nothing left. Being wedged and being finished both look quiet, and this '
      + 'is the line that tells them apart.');
    assert.equal(N.state.notes.some((n) => n.id === 'nachO'), false,
      'NO CONTENT CROSSED, and that is §4\'s gate and not a sync defect: every row above the hole '
      + 'was authored by ANOTHER MEMBER, and in a personal space `core/authz.js` refuses those as '
      + '`notMyAct` — 21.2 holding exactly as designed. It is also the whole reason this row can '
      + 'only measure the CURSOR and the VERDICT: there is no family engine to measure content '
      + 'convergence with.');
    assert.equal(r.criedWolf, true,
      'THE FINDING (R10-11): she IS told the relay\'s record does not add up, on her first day, '
      + 'because a member she never met was removed before she arrived. Nothing is wrong. This '
      + 'row asserts the DEFECT and must be inverted when it is closed — the shortest fix named in '
      + 'the go/no-go is ADR 003 §4.1\'s `baselineSeq`: a break BELOW the baseline a joiner '
      + 'recorded at first pull is not a finding, because she can prove nothing about a range she '
      + 'was never served.');
    assert.deepEqual((r.chain || []), ['gap'],
      'and the verdict is a GAP — the removal\'s shape, which R10-4 pins as indistinguishable at '
      + 'this client from a relay withholding rows');
    assert.equal(N.state.notes.some((n) => n.id === 'jo1'), false,
      'and none of the removed member\'s entries did, which is story 20.2 holding');

    // ── THE BOUND, MEASURED. One entry from anybody and the verdict is gone. ─────────────────
    await A.apply('createNotePopover', { id: 'endlich', date: '2027-07-20', text: 'endlich', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    for (let i = 0; i < 3; i++) {
      clock.advance(MINUTE * 10);
      await N.sync();
    }
    assert.equal(N.storeDiagnostics().sync.chain, null,
      'THE BOUND: the next entry anybody writes moves her head, and positive evidence withdraws '
      + 'the verdict. So R10-11 is a bounded false red and not a permanent one — but the bound is '
      + 'somebody else\'s behaviour, not this Mac\'s, and that is why it is still a finding.');
    assert.notEqual(N.cursor(), head, 'NON-VACUITY: the head really did move for her');

    // ── AND THE HONEST CEILING, MEASURED RATHER THAN CLAIMED ────────────────────────────────
    //
    // ADR 003 §4.1 R5's copy contract is „seit dem Beitritt geprüft", never „geprüft", and this is
    // the line that makes that a fact about the build. She crossed a hole; she cannot know whether
    // it was a removal or a relay withholding from her (R10-4), and the ONLY honest position is
    // that her verification starts where her evidence starts.
    assert.equal(N.storeDiagnostics().sync.chain, null,
      'she alleges nothing, because she can prove nothing about a range she was never served');

    // THE CONTROL: her ceiling is a ceiling and not a switched-off detector.
    await A.apply('createNotePopover', { id: 'spaeter', date: '2027-07-05', text: 'später', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    clock.advance(MINUTE * 10);
    await N.pull();
    f.wire.honest();
    assert.equal(N.status().state, 'error',
      'CONTROL: from her join onward she verifies for real. A lie told to the NEWEST member, past '
      + 'a removal she never saw, is still caught.');
  });

  test('§3b · a removal DURING a partition — the offline Mac comes back to a changed circle', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C'], clock });
    const A = f.device('A');
    const B = f.device('B');
    const C = f.device('C');
    await f.settle(2);
    const O = await joinNewMember(f, { name: 'O', colorRef: 'blau' });

    for (let i = 0; i < 3; i++) {
      await A.apply('createNotePopover', { id: `pa${i}`, date: `2027-05-0${i + 1}`, text: `A ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
      await O.apply('createNotePopover', { id: `po${i}`, date: `2027-06-0${i + 1}`, text: `O ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await O.push();
    }
    clock.advance(MINUTE * 10);
    await f.settle(2);
    const cBefore = C.cursor();
    assert.ok((await logOf(f)).some((o) => o.deviceShort === O.short),
      'NON-VACUITY: her rows are in the log before the partition, so the removal that happens '
      + 'while C is away really does change the range C is about to pull through');

    // ── C GOES INTO A TUNNEL. The removal happens without it. ────────────────────────────────
    C.offline();
    const rm = await A.run(() => A.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: f.spaceId, memberId: O.memberId,
    }));
    assert.equal(rm.status, 200, JSON.stringify(rm.json));
    for (let i = 0; i < 3; i++) {
      await A.apply('createNotePopover', { id: `nach${i}`, date: `2027-07-0${i + 1}`, text: `nach ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
    }
    clock.advance(MINUTE * 10);
    await B.sync();

    // ── AND COMES BACK. Its cursor is BELOW the hole, which is the shape that matters: it will
    //    pull straight through a range that changed while it was away.
    C.online();
    for (let i = 0; i < 6; i++) {
      clock.advance(MINUTE * 10);
      await C.sync();
    }

    const r = syncReading(C);
    assert.equal(r.chain, null,
      'THE RESULT: the Mac that was away rejoins without accusing the relay. It pulled across a '
      + 'range whose contents changed underneath it — which is exactly what a hostile relay would '
      + 'also produce, and the engine cannot tell them apart (R10-4).');
    assert.equal(r.criedWolf, false, 'and says nothing about it to its user');
    assert.notEqual(r.cursor, cBefore, 'and its cursor moved through the hole');
    assert.equal(C.state.notes.some((n) => n.id === 'nach2'), true,
      'and it caught up past the hole — everything authored during the partition arrived');

    // WHAT IT DOES **NOT** DO, and this is the finding rather than the reassurance: C still holds
    // O's entries locally. A removal purges the RELAY's rows; it cannot reach into a board that
    // already applied them (ADR 002 §7.4, which the handler itself reports as
    // `alreadyDeliveredIsIrrevocable`). So the three Macs do NOT converge on content here.
    // ── THE RESIDUAL THE HANDLER ITSELF NAMES ───────────────────────────────────────────────
    //
    // `alreadyDeliveredIsIrrevocable: true` is in the removal's own response body, and it is the
    // honest half of story 20.2: a removal purges the RELAY's rows and cannot reach a board that
    // already applied them. In THIS fleet nothing applied them — the space is personal and
    // `notMyAct` refused every one (§4) — so what is asserted here is the handler's admission
    // rather than a board state, and E6 has to answer the product question behind it: when Oma is
    // removed, do her entries leave the boards that already show them?
    assert.equal(rm.json.alreadyDeliveredIsIrrevocable, true,
      'THE RESIDUAL, ASSERTED SO IT CANNOT BE FORGOTTEN: the relay states that what has already '
      + 'been delivered cannot be recalled. No client behaviour changes that, and it is a PRODUCT '
      + 'decision E6 owes rather than a sync-engine defect.');
  });

  test('§3c · TWO REMOVALS RACING — two members removed from two devices, at once', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle(2);
    const O = await joinNewMember(f, { name: 'O', colorRef: 'blau' });
    const P = await joinNewMember(f, { name: 'P', colorRef: 'gelb' });
    assert.equal(new Set([A.memberId, O.memberId, P.memberId]).size, 3,
      'NON-VACUITY: THREE members, and four devices in the fleet — E6\'s shape, not M1\'s');

    for (let i = 0; i < 2; i++) {
      for (const [who, tag] of [[A, 'a'], [O, 'o'], [P, 'p']]) {
        await who.apply('createNotePopover', { id: `${tag}${i}`, date: `2027-0${i + 5}-0${i + 1}`, text: `${tag}${i}`, categoryId: 'c1' });
        clock.advance(MINUTE);
        await who.push();
      }
    }
    clock.advance(MINUTE * 10);
    await B.sync();
    const beforeCursor = B.cursor();

    // ── THE RACE, MODELLED THE WAY IT ACTUALLY HAPPENS ──────────────────────────────────────
    //
    // NOT `Promise.all`: the fleet harness refuses two devices in flight at once ("a device disk
    // is already mounted; devices are driven one at a time"), and that refusal is right — two Macs
    // do not share a process. The race that matters is not simultaneity in the client; it is that
    // NEITHER ISSUER HAS SEEN THE OTHER'S WRITE. Both requests are therefore built from the same
    // pre-race view and sent back to back with no pull between them, which is exactly what two
    // people pressing „Entfernen" within the same poll interval produces. The relay is where the
    // ordering is decided, and the relay is real here.
    const r1 = await A.run(() => A.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: f.spaceId, memberId: O.memberId,
    }));
    const r2 = await B.run(() => B.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: f.spaceId, memberId: P.memberId,
    }));
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.ok(r1.json.purgedOps > 0 && r2.json.purgedOps > 0,
      'NON-VACUITY: BOTH removals purged rows, so this is a race between two real destructive '
      + 'operations and not one removal with a spectator');

    const members = await f.relay.store.listMembers(f.spaceId);
    const live = members.filter((m) => !m.removedAt);
    assert.equal(members.length, 3, 'three members were really in this space');
    assert.equal(live.length, 1,
      'THE RESULT, SERVER SIDE: both removals stuck. The membership transaction serialises them — '
      + 'neither is lost, and neither overwrites the other\'s purge.');
    assert.equal(live[0].id, A.memberId,
      'and the survivor is the one nobody removed. (`listMembers` keys the row `id`; the fleet '
      + 'device exposes it as `memberId` — one join, written out so a rename on either side is '
      + 'caught here rather than silently comparing two undefineds.)');
    assert.ok(live[0].id, 'NON-VACUITY: and it is a real id, not an absent field matching another');

    // ── TWO HOLES, IN ONE LOG, FOR ONE SURVIVING MAC ────────────────────────────────────────
    const after = await logOf(f);
    assert.equal(after.some((o) => o.deviceShort === O.short), false, 'O\'s rows are gone');
    assert.equal(after.some((o) => o.deviceShort === P.short), false, 'and so are P\'s');
    const seqs = after.map((o) => Number(o.seq));
    const holes = seqs.filter((v, i) => i > 0 && v !== seqs[i - 1] + 1).length;
    assert.ok(holes >= 1,
      `NON-VACUITY: the surviving log is not contiguous (${holes} discontinuit${holes === 1 ? 'y' : 'ies'})`);

    await A.apply('createNotePopover', { id: 'danach', date: '2027-08-01', text: 'danach', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    for (let i = 0; i < 6; i++) {
      clock.advance(MINUTE * 10);
      await B.sync();
    }

    const r = syncReading(B);
    assert.equal(r.chain, null,
      'THE RESULT, CLIENT SIDE: two purges in one log, met by one pull, and the survivor is not '
      + 'wedged and accuses nobody. R8-2\'s bound is per-pull and not per-hole, which is what makes '
      + 'a race survivable rather than twice as bad as one removal.');
    assert.equal(r.criedWolf, false, 'and nothing is said to the user about a relay that obeyed');
    assert.notEqual(r.cursor, beforeCursor, 'and the cursor moved through BOTH holes');
    assert.equal(B.state.notes.some((n) => n.id === 'danach'), true, 'and the entry above them landed');

    // THE CONTROL: two holes did not exhaust the detector.
    await A.apply('createNotePopover', { id: 'zuletzt', date: '2027-08-02', text: 'zuletzt', categoryId: 'c1' });
    clock.advance(MINUTE);
    await A.push();
    f.wire.hostile.onResponse = MUTATORS.rewriteChain((o, i) => (i === 0 ? 'AAAA' + o.chain.slice(4) : null));
    clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();
    assert.equal(B.status().state, 'error',
      'CONTROL: after TWO purges the witness still catches a rewritten value. Each purge costs one '
      + 're-anchor, not the right to verify.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE GATE — WHY THIS IS A NO-GO, ASSERTED RATHER THAN ARGUED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above is green, and none of it is E6.
//
// §3 drove three members and four devices, and every one of those rows had to measure the CURSOR
// and the VERDICT rather than the BOARD, because no content ever crossed between members. That is
// not an accident of the harness and it is not a defect to fix in the engine: the space the
// product can sync is a PERSONAL space, and a personal space holding one person's acts is story
// 21.2 — the promise the whole crypto design exists to keep.
//
// The consequence is the gate: **E6's convergence question cannot be asked of this build**, and a
// suite full of green rows must not be read as evidence that it can. The three assertions below
// are what stop that misreading. Each is a statement about the SHIPPED source, so it inverts on
// the day a family engine exists rather than on the day somebody remembers to come back.

describe('§4 · the gate — E6 needs a family space, and nothing can sync one', () => {
  test('§4a · the shipped engine REFUSES a family space, by construction and on purpose', async () => {
    const { createPersonalSync } = await import('../../src/js/sync/personal.js');
    assert.throws(
      () => createPersonalSync({
        spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA',
        store: {}, transport: {}, keyring: {}, attestationOf: () => null,
      }),
      /must be a psp_/,
      'THE GATE, HALF ONE: `assertPersonalSpace()` throws on an `fsp_…` id. This is CORRECT — it '
      + 'is 21.2 enforced at construction, and `personal.js`\'s header calls it "negative work" '
      + 'done deliberately. It is quoted here as a FACT ABOUT SCOPE, not as a defect: the engine '
      + 'that has been hardened for three rounds is not the engine E6 needs.');
  });

  test('§4b · and no OTHER engine exists — `family/engine.js` builds the personal one', () => {
    // Measured over the source, in `round9-e6.test.js` §3c's discipline, so an engine added in a
    // file nobody thought of inverts this row instead of hiding behind it.
    const dir = path.join(REPO, 'src/js/sync');
    const modules = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
    assert.deepEqual(modules.sort(),
      ['chain.js', 'cursor.js', 'outbox.js', 'personal.js', 'protocol.js', 'status.js'],
      'THE GATE, HALF TWO: there are six modules under `src/js/sync/` and exactly one of them is '
      + 'an engine. There is no `family.js`, and this row inverts the day there is.');

    const engine = fs.readFileSync(path.join(REPO, 'src/js/family/engine.js'), 'utf8');
    assert.match(engine, /createPersonalSync/,
      'and `family/engine.js` — the file whose NAME says family — builds the PERSONAL engine');
    assert.match(engine, /startsWith\('psp_'\)/,
      'and gates itself on a `psp_` id, so „Familie" in this product means "my own Macs, over a '
      + 'relay", which is M1 and is exactly what E5 shipped and demonstrated');
  });

  test('§4c · the relay, meanwhile, ADMITS a second member to a personal space (R10-10)', async () => {
    // Not a confidentiality break, and said plainly so it is not over-read: she cannot decrypt
    // anything — `SK_personal` is never handed to a joiner by any relay path, and every client
    // refuses her ops with `notMyAct` regardless. What is missing is the relay's own half of the
    // rule: the membership doors do not look at the space KIND, so the only thing standing between
    // a personal space and a second member is that no UI offers it.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    await f.settle(2);
    assert.match(f.spaceId, /^psp_/, 'NON-VACUITY: this really is a personal space');

    await joinNewMember(f, { name: 'O', colorRef: 'blau' });
    const members = await f.relay.store.listMembers(f.spaceId);
    assert.equal(members.length, 2,
      'THE ROW (R10-10, LATENT): `POST /invites` and `POST /invites/redeem` admitted a SECOND '
      + 'MEMBER to a `psp_` space, over the real handlers. Story 21.2 says a personal space is one '
      + 'person\'s. The client barrier holds and the crypto barrier holds — this is the third one, '
      + 'defence in depth, and it is absent. Inverts when the membership doors refuse a non-`fsp_` '
      + 'space; until then the register carries it as LATENT rather than as a break.');
  });
});
