// FLEET · ROUND 9 — THE TWO CHECKS E6 IS ALLOWED TO STAND ON.
// ADR 002 §5.4 · ADR 003 §3.3, §6.3, §8.2 · ADR 006 §9.1 (W1) · stories 20.2, 19.3, F-6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AND WHY IT IS NOT ANOTHER CHAIN TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 8 put ADR 002 §5.4's chain witness on the product's pull path and got two things wrong at
// once: it imported the LEAF (`verifyChain`) rather than the stateful wrapper beside it
// (`createChainWitness`), and it then gave the leaf a power the ADR forbids in one sentence —
// *"it NEVER BLOCKS SYNC in v2 (a false positive that broke a family's board would be far worse
// than the attack)"*. An adversary read the result and returned a verdict: **E6 cannot safely be
// built on this sync engine as it stands.**
//
// `round8-chain.test.js` inverts the rows that verdict was made of, one mechanism at a time.
// THIS file is the other half — the two end-to-end statements the adversary set as the bar, each
// driven through the real handlers, because a detector is only trustworthy if it is quiet on the
// two inputs a family actually produces:
//
//   §1  FIRST CONTACT. A peer's content op overtakes its attestation, the relay HONESTLY re-serves
//       the held page on every poll, and the client must stay `pending` and must never say the
//       server's record of the board does not add up. This is F-6, it happens on a completely
//       honest relay every time a second Mac is adopted, and it is where round 8 cried wolf.
//
//   §2  A MEMBER REMOVAL. `POST /members/remove` through the real router — `purgeMember` deletes
//       the removed member's `Op` rows in the same transaction (ADR 003 §6.3, story 20.2) — and
//       EVERY remaining device must converge, keep its cursor moving, and reach every entry that
//       still exists. Over a log longer than one page, and across a relaunch. This is where
//       round 8 wedged: an unfillable hole held the cursor for ever and everything above it was
//       unreachable on an honest relay, permanently.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT MAKES THESE DIFFERENT FROM THE ROWS IN `round8-chain.test.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `round8-chain.test.js` §2 reaches the purge by calling `store.deleteOpsByDevices` — the exact
// call the handler makes, and the right level for a row about the WITNESS. But a client tested
// against its own idea of what a removal does is not tested against a removal. §2 below drives
// `POST /invites`, `POST /invites/redeem` and `POST /members/remove` through `router.js` over
// `adapters/memory.js`, with a real third device holding real keys and authoring real ops, so
// what tears the hole in the log is the product's own destructive operation and not a test's
// impression of it. `tests/helpers/fleet.js joinNewMember` is that setup, and its docblock says
// which two things it deliberately does not model.
//
// Both sections are NON-VACUOUS BY CONSTRUCTION and say so in their own assertions: §1 asserts
// that the op really was held (not merely that nothing went wrong), and §2 asserts that the
// handler really purged rows and that the log really was longer than one page.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFleet, createRelay, joinNewMember, simClock, MINUTE,
} from '../helpers/fleet.js';
import { MAX_DEFERRALS } from '../../src/js/sync/personal.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n1', date: '2027-03-04', text: 'Zahnarzt 14:30', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const findings = (dev) => (dev.storeDiagnostics().sync.chain?.findings || []);
/** Every sentence this Mac has said to its user this session. */
const said = (dev) => dev.warnings().join(' ¶ ');

/**
 * THE SENTENCE THAT MUST NOT APPEAR ON AN HONEST RELAY.
 *
 * `noteChain` has two of them and both begin this way. It is matched as a REGEX over the warning
 * channel rather than compared to a constant on purpose: the check is about what a user is told,
 * so re-wording the message must not be able to make this pass. If the sentence is ever
 * rewritten, this pattern has to be rewritten with it, deliberately.
 */
const CRIED_WOLF = /does not add up|no longer check the server's record/;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · HEADLINE (a) — FIRST CONTACT. THE DETECTOR MAY NOT CRY WOLF ON THE HAPPY PATH.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// F-6, and it is not exotic: `tests/helpers/fleet.js` S-1 records that at M1 the attestation hop
// HAS NO WIRE — neither the log nor the relay can deliver one — so a second Mac adopted while the
// first is asleep, or a pairing that has not finished, is the ordinary state of a family for as
// long as it takes. The op arrives first, `openOp` parks it on P1, the cursor is held below it
// (W1), and the relay — honest, with nothing to hide — serves THE SAME PAGE again on the next
// poll because the cursor did not move.
//
// Round 8 read that re-serve as a fork. `chainAnchor` advanced whenever a PAGE verified while the
// CURSOR advanced only when nothing in the page was held, so the second pull verified the page
// against an anchor taken from inside itself and reported `seq jumped from 1 to 1`. The witness's
// `fresh` filter is the whole fix: rows at or below the verified head are dropped before any check
// runs, because a row this device has already folded is evidence about the CALLER and not about
// the relay.
describe('§1 · HEADLINE (a) · first contact — held, quiet, and never accused', () => {
  test('an op overtakes its attestation; six honest re-serves and not one accusation', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    const attA = f.attestations.get(A.short);
    f.attestations.delete(A.short);            // fleet.js S-1: at M1 this hop has no wire at all
    await A.apply('createNotePopover', {
      id: 'absage', date: '2027-06-07', text: 'Mama sagt ab', categoryId: 'c1',
    });
    await A.push();

    // ADR 003 §8.2 BOUNDS THE HOLD, so the loop is the product's own bound and not a round
    // number: `MAX_DEFERRALS` pulls while the op is held, then the ladder ends it. Every one of
    // those pulls re-serves the same page, which is the input round 8 read as a fork.
    const held = B.cursor();
    for (let i = 0; i < MAX_DEFERRALS; i++) {
      clock.advance(MINUTE * 10);
      await B.pull();

      // NON-VACUITY, INSIDE THE LOOP. Without this the whole section is satisfied by a relay that
      // served nothing at all, which is the failure mode of every "and nothing bad happened" row.
      assert.equal((await B.heldEnvelopes()).length, 1,
        `pull ${i}: the op really is being HELD — this row is not measuring an empty page`);
      assert.equal(B.cursor(), held,
        `pull ${i}: and the cursor is held below it, which is what makes the relay re-serve`);

      // ── THE HEADLINE ASSERTION ────────────────────────────────────────────────────────────
      assert.deepEqual(findings(B), [],
        `pull ${i}: the witness reported a finding about an HONEST relay re-serving a page this `
        + 'device asked it to re-serve. That is the false positive ADR 002 §5.4 spends its one '
        + 'sentence forbidding, and round 8 produced it from the second pull onwards.');
      assert.equal(B.storeDiagnostics().sync.chain, null,
        `pull ${i}: and nothing was written to the durable chain verdict either`);
      assert.equal(CRIED_WOLF.test(said(B)), false,
        `pull ${i}: NOTHING was said to the user. A family whose second Mac is still being paired `
        + 'is not a family whose relay is lying to them.');
      assert.equal(B.status().state, 'pending',
        `pull ${i}: a held op is work outstanding — pending, never error and never healthy`);
      assert.equal(B.status().errorKind, null, `pull ${i}: with no error kind, because none failed`);
    }

    // ── THE LADDER ENDS THE HOLD — AND STILL SAYS NOTHING ABOUT THE RELAY ────────────────────
    //
    // The sixth pull is where ADR 003 §8.2's bound fires: the deferral becomes a refusal, the
    // cursor is released, and the sealed envelope is SHELVED rather than destroyed (R8-4). What
    // matters here is what is NOT said: the ladder giving up is a statement about this device's
    // knowledge, never about the relay's honesty.
    clock.advance(MINUTE * 10);
    await B.pull();
    assert.notEqual(B.cursor(), held, 'the ladder released the cursor — ADR 003 §8.2 requires a bound');
    assert.deepEqual(findings(B), [],
      'and the relay was STILL never accused. Six honest re-serves of a page this device asked '
      + 'for, and not one chain finding.');
    assert.equal(CRIED_WOLF.test(said(B)), false, 'and not one word of it to the user');

    // ── AND THE CURE LANDS, WHICH IS WHAT THE RETENTION WAS FOR ──────────────────────────────
    //
    // The attestation arrives — pairing finishes, or the other Mac wakes up — and the entry is
    // delivered by the first launch after it. A park is a deferral and may never become a drop,
    // including at the end of the ladder.
    f.attestations.set(A.short, attA);
    await B.close();
    await B.open();
    clock.advance(MINUTE * 10);
    await B.catchUp();
    assert.equal(B.state.notes.some((n) => n.id === 'absage'), true,
      'the attestation arrived and the entry with it — the hold was a deferral, not a drop');
    assert.equal(B.status().state, 'healthy', 'the indicator goes quiet, which is 19.3\'s promise');
    assert.equal(B.storeDiagnostics().sync.refused, 0,
      'and the refusal the ladder recorded is WITHDRAWN, because the op it named has landed (R8-4)');
    assert.deepEqual(findings(B), [], 'and it was never accused, at any point in the sequence');
  });

  // ── THE CONTROL. QUIET ON THE HAPPY PATH MUST NOT MEAN QUIET FULL STOP. ───────────────────
  //
  // §1's row is an assertion that a detector says NOTHING, and the cheapest way to pass such a row
  // is to have no detector. So the same fleet, the same held page, and one dishonest byte: the
  // relay renumbers a row's `chain`. It must still be caught, in the same state §1 measures.
  test('CONTROL · with the SAME page held, one rewritten chain value is still caught', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    const B = f.device('B');
    await f.settle();

    const attA = f.attestations.get(A.short);
    f.attestations.delete(A.short);
    await A.apply('createNotePopover', { id: 'x1', date: '2027-06-07', text: 'eins', categoryId: 'c1' });
    await A.push();
    clock.advance(MINUTE * 10);
    await B.pull();                                   // held, quiet — §1's state exactly
    assert.deepEqual(findings(B), [], 'the control starts from the SAME quiet state §1 asserts');

    // The cure lands and A writes more, so there are FRESH rows above the head to lie about.
    f.attestations.set(A.short, attA);
    for (let i = 0; i < 3; i++) {
      await A.apply('createNotePopover', { id: `y${i}`, date: `2027-07-0${i + 1}`, text: `y${i}`, categoryId: 'c1' });
    }
    clock.advance(MINUTE * 10);
    await A.push();

    f.wire.hostile.onResponse = (res, req) => {
      if (!/\/ops/.test(req.path) || !res.body || !Array.isArray(res.body.ops)) return res;
      const ops = res.body.ops.map((o, i) => (i === res.body.ops.length - 1
        ? { ...o, chain: 'Aq'.padEnd(43, 'B') }        // one rewritten value, nothing else touched
        : o));
      return { ...res, body: { ...res.body, ops } };
    };
    clock.advance(MINUTE * 10);
    await B.pull();
    f.wire.honest();

    assert.notDeepEqual(findings(B), [],
      'A REWRITTEN CHAIN VALUE WENT UNREPORTED. §1 asserts the detector is silent on an honest '
      + 'relay; this row is what stops that from being satisfiable by deleting the detector.');
    assert.match(said(B), CRIED_WOLF,
      'and the user is told, because this time there is something to tell them');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · HEADLINE (b) — A MEMBER REMOVAL MUST NOT WEDGE ANYONE.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Story 20.2, ADR 003 §6.3: `POST /members/remove` purges the removed member's `Op` rows in the
// same transaction as the membership write. `Op.chain` is a hash chain over the space's log in
// insertion order, so deleting rows makes every subsequent `chain` value **unrecomputable by
// anyone, for ever** — the surviving log no longer contains the opIds the hashes were taken over.
//
// That is not an attack. It is the one legitimate destructive operation in the product, performed
// by a family through the UI, and round 8's engine answered it by holding the cursor below the
// hole on every pull, unconditionally and for ever. Every op above the hole was unreachable,
// across relaunches, on a relay that had done exactly what it was asked to do. Nobody could clear
// it, and nobody could see why.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS TWO ROWS AND NOT ONE — THE SEAM E6 IS ABOUT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The obvious shape of this check is one row: a family, one member removed through the real
// route, the survivors keep syncing. It cannot be written today, and the reason is worth stating
// exactly rather than working around quietly.
//
// **There is no family sync client yet.** `createPersonalSync` refuses a non-`psp_` space id in
// its first line, deliberately and loudly (`assertPersonalSpace`, story 21.2: *"a personal sync
// engine pointed at a family space would push the user's private board into the family stream,
// which is the single worst thing this product could do"*). And in a PERSONAL space, ADR 001 §4's
// stage 2 rejects another member's op with `notMyAct` before the chain witness is anywhere near
// it — correctly, and it is measured: writing this row the naive way produced exactly that
// refusal. So the two halves of the removal live on opposite sides of a seam that **E6 is the
// work package for**.
//
// They are therefore driven separately, and JOINED BY MEASUREMENT rather than by assumption:
//
//   §2a  THE SERVER HALF, FULLY REAL. A second member joins through `POST /invites` and
//        `POST /invites/redeem`, authors ops, and is removed through `POST /members/remove` —
//        all over `router.js` and `adapters/memory.js`. The row CAPTURES the store call the
//        handler makes, so what §2b replays is not this test's idea of a purge but the arguments
//        `purgeMember` actually passed.
//   §2b  THE CLIENT HALF, FULLY REAL. Three Macs of one member on a personal space, a log many
//        pages long, and the captured call applied to the same shipped memory adapter. Every
//        remaining device must converge, keep its cursor moving and reach every entry that still
//        exists — over several pages and across a relaunch.
//
// What is NOT proved by the pair is that a family-space client survives it, because there is no
// such client to prove it about. That is E6's first obligation and it is written into §2b's
// closing assertion so it cannot be forgotten.

/** What `purgeMember` asked the store to delete. Filled by §2a, replayed by §2b. */
let CAPTURED = null;

describe('§2a · HEADLINE (b), server half · POST /members/remove, over the real router', () => {
  test('a real second member is removed, and her ops leave the log with her', async () => {
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    // Two Macs, because `assertDistinctIdentities` refuses a one-device fleet — "a fleet of one
    // device proves nothing about convergence". B is a bystander here; §2b is where the survivors
    // are the point.
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], clock });
    const A = f.device('A');
    await f.settle();

    // ── SHE JOINS, THROUGH THE REAL INVITE HANDLERS ─────────────────────────────────────────
    const O = await joinNewMember(f, { name: 'O', colorRef: 'blau' });
    assert.notEqual(O.memberId, A.memberId, 'Oma is a MEMBER, not another Mac of the same person');
    const members = await f.relay.store.listMembers(f.spaceId);
    assert.equal(members.length, 2, 'and the relay agrees, because a real handler wrote the row');

    // ── AN INTERLEAVED LOG. Her rows must sit BETWEEN the survivor's, not at the end: a purge
    // that only ever truncates the tail is the withhold-at-the-end shape, which the page-claim
    // check catches and which is not what a removal produces.
    for (let i = 0; i < 4; i++) {
      await A.apply('createNotePopover', { id: `a${i}`, date: `2027-05-0${i + 1}`, text: `Papa ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await A.push();
      await O.apply('createNotePopover', { id: `o${i}`, date: `2027-06-0${i + 1}`, text: `Oma ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await O.push();
    }
    const before = (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops;
    assert.ok(before.some((o) => o.deviceShort === O.short), 'her ops are really in the log');
    assert.ok(before.some((o) => o.deviceShort === A.short), 'and so are his, interleaved with them');

    // ── THE CAPTURE. What does `purgeMember` actually ask the store to do? ───────────────────
    //
    // Measured rather than read off the handler's source, so what §2b replays is the call this
    // route really makes. The spy goes on `store.tx` and wraps the HANDLE it yields, because
    // `purgeMember` runs inside the membership transaction and reaches `tx.deleteOpsByDevices` —
    // a spy on the bare store method is never called, which is itself worth knowing: the purge
    // and the membership write are one transaction, so neither can land without the other.
    // Restored in a `finally`, since a spy left on a shared adapter is how one row poisons the next.
    const realTx = f.relay.store.tx.bind(f.relay.store);
    const calls = [];
    f.relay.store.tx = (fn) => realTx(async (h) => {
      const inner = h.deleteOpsByDevices.bind(h);
      h.deleteOpsByDevices = async (spaceId, shorts) => {
        calls.push({ spaceId, shorts: [...shorts] });
        return inner(spaceId, shorts);
      };
      return fn(h);
    });

    let res;
    try {
      clock.advance(MINUTE);
      res = await A.run(() => A.transport.request('POST', '/api/v1/members/remove', undefined, {
        spaceId: f.spaceId, memberId: O.memberId,
      }));
    } finally {
      f.relay.store.tx = realTx;
    }

    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.removed, true);
    assert.ok(res.json.purgedOps > 0,
      'NON-VACUITY: the handler really deleted op rows. A removal that purged nothing would make '
      + 'every assertion below pass for the wrong reason (ADR 003 §6.3, story 20.2).');
    assert.equal(res.json.rotateRequired, true, 'and it states ADR 002 §4.1\'s obligation, as it must');
    assert.equal(res.json.alreadyDeliveredIsIrrevocable, true,
      'and tells the client the truth about what a removal cannot undo (ADR 002 §7.4), so the '
      + 'client cannot claim something stronger on screen');

    // ── THE JOIN TO §2b ─────────────────────────────────────────────────────────────────────
    assert.equal(calls.length, 1, 'the purge is ONE call, inside the membership transaction');
    assert.equal(calls[0].spaceId, f.spaceId);
    assert.deepEqual(calls[0].shorts, [O.short],
      'and it is keyed on the removed member\'s DEVICE SHORTS (ADR 002 §2.3) — which is the exact '
      + 'shape §2b replays, so the client half is answering the real question');
    CAPTURED = { method: 'deleteOpsByDevices', shorts: calls[0].shorts.length };

    // ── THE HOLE IS REAL, AND IT IS IN THE MIDDLE ───────────────────────────────────────────
    const after = (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops;
    assert.equal(after.some((o) => o.deviceShort === O.short), false,
      'the relay serves none of the removed member\'s ops to anybody any more (story 20.2)');
    const seqs = after.map((o) => Number(o.seq));
    assert.ok(seqs.some((v, i) => i > 0 && v !== seqs[i - 1] + 1),
      'and the surviving seqs are NOT contiguous. That gap is the input the whole of §2b is about: '
      + '`seq` is gapless per space (ADR 003 §3.3), so to a client this is indistinguishable from '
      + 'a relay withholding rows — which is precisely why round 8 held the cursor for ever.');
    assert.ok(Math.max(...seqs) > Math.min(...seqs.filter((v) => v > seqs[0])),
      'with survivors ABOVE the hole, which is what makes it a wedge rather than a truncation');
  });
});

describe('§2b · HEADLINE (b), client half · every remaining device survives the hole', () => {
  test('three Macs, a multi-page log, the captured purge — and nobody is wedged', async () => {
    assert.notEqual(CAPTURED, null,
      '§2a must run first: this row replays the store call IT measured, so running it alone would '
      + 'be replaying an assumption');
    assert.deepEqual(CAPTURED, { method: 'deleteOpsByDevices', shorts: 1 });

    // A TWO-ROW PAGE, so "the cursor moved" cannot be satisfied by one page that happened to
    // contain everything, and page two has to be asked for.
    const clock = simClock(Date.UTC(2026, 11, 10, 9, 0, 0));
    const base = createRelay().limits;
    const relay = createRelay({ clock, limits: { ...base, opsPerPull: 2 } });
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B', 'C'], clock, relay });
    const A = f.device('A');
    const B = f.device('B');
    const C = f.device('C');
    /** Sync with the rate window cleared, so nothing here can be a 429 wearing a disguise. */
    const slowSync = async (dev, n) => {
      for (let i = 0; i < n; i++) { clock.advance(MINUTE * 10); await dev.sync(); }
      assert.equal(dev.status().consecutiveFailures, 0, 'every request in this phase was answered 200');
    };
    await f.settle();

    // ── THE TWO POSITIONS A SURVIVOR CAN BE IN, AND ONLY ONE OF THEM IS THE HARD ONE ────────
    //
    // A device whose cursor is already ABOVE the purged rows never sees the hole at all — the
    // witness's `fresh` filter drops everything at or below its head, so there is nothing to
    // detect and nothing to hold. That is worth having in the row, and on its own it would be a
    // check that passes for the wrong reason.
    //
    // The device that matters is the one whose cursor is BELOW the hole when the purge lands: the
    // Mac that was shut, or in a tunnel, while the family removed somebody. It pulls ACROSS the
    // gap on its next launch, and that is the pull round 8 wedged for ever. So B goes offline for
    // the whole build-up and stays there through the removal.
    //
    //   A — online throughout; cursor ABOVE the hole before it exists
    //   B — OFFLINE throughout; cursor at 0, so its first pull after the purge crosses the gap
    //
    B.offline();
    const survives = [];
    for (let i = 0; i < 4; i++) {
      const id = `a${i}`;
      await A.apply('createNotePopover', { id, date: `2027-05-0${i + 1}`, text: `Papa ${i}`, categoryId: 'c1' });
      survives.push(id);
      clock.advance(MINUTE);
      await A.push();
      await C.apply('createNotePopover', { id: `c${i}`, date: `2027-06-0${i + 1}`, text: `weg ${i}`, categoryId: 'c1' });
      clock.advance(MINUTE);
      await C.push();
    }
    await slowSync(A, 6);
    for (const id of survives) {
      assert.equal(A.state.notes.some((n) => n.id === id), true, `A has ${id} before the purge`);
    }
    assert.equal(A.state.notes.some((n) => n.id === 'c0'), true,
      'and A could read the soon-to-be-purged entries too — a working family, not a partition');
    assert.equal(A.status().state, 'healthy', 'everything is quiet before the removal');
    const bBefore = B.cursor();
    assert.equal(bBefore, '0', 'and B has pulled NOTHING: its cursor is below every row that exists');

    const before = (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops;
    assert.ok(before.length > 3 * 2,
      `the log is ${before.length} rows over a two-row page — several pages, as the check requires`);

    // ── THE PURGE: §2a's CAPTURED CALL, ON THE SAME SHIPPED ADAPTER ─────────────────────────
    const purged = await f.relay.store.deleteOpsByDevices(f.spaceId, [C.short]);
    assert.ok(purged > 0, 'the rows are gone — `store-interface.js` C25 pins these semantics');
    const seqs = (await f.relay.store.listOps(f.spaceId, 0n, 1000)).ops.map((o) => Number(o.seq));
    assert.ok(seqs.some((v, i) => i > 0 && v !== seqs[i - 1] + 1),
      'and the hole is in the middle of what is left, exactly as §2a measured on the real handler');

    // ── LIFE GOES ON. The family keeps using the board after the removal. ───────────────────
    for (let i = 0; i < 5; i++) {
      const id = `p${i}`;
      await A.apply('createNotePopover', { id, date: `2027-08-0${i + 1}`, text: `nachher ${i}`, categoryId: 'c1' });
      survives.push(id);
    }
    clock.advance(MINUTE * 10);
    await A.push();

    // B comes back. Its very first pull of the session crosses the hole.
    B.online();

    // ── EVERY REMAINING DEVICE. Both of them, and the assertions are identical for each. ────
    for (const dev of [A, B]) {
      const at = dev.cursor();
      await slowSync(dev, 10);
      assert.notEqual(dev.cursor(), at,
        `${dev.name}: THE CURSOR IS STILL MOVING. Round 8 stopped it here for ever, waiting for `
        + 'rows a member removal had deleted on purpose — an unfillable hole held as though the '
        + 'relay were withholding, which is the wedge this whole round is about.');
      const missing = survives.filter((id) => !dev.state.notes.some((n) => n.id === id));
      assert.deepEqual(missing, [],
        `${dev.name}: EVERY ENTRY THAT STILL EXISTS IS HERE — the four from before the removal and `
        + 'the five from after it, across several pages. That is the second half of "not wedged": '
        + 'a cursor that moves but skips is worse than one that stops.');
      assert.equal(dev.quarantined().length, 0,
        `${dev.name}: and nothing was refused on the witness's word — ADR 002 §8.6, ADR 003 §10.6`);
      assert.equal(dev.status().state, 'healthy',
        `${dev.name}: the indicator is OUT. A break that has been re-anchored past is not a fork, `
        + 'and a red light nobody can clear is a red light everybody learns to ignore.');
    }

    // ── AND THEY AGREE ON EVERYTHING THAT STILL EXISTS ──────────────────────────────────────
    //
    // NOT on everything full stop, and the difference is ADR 002 §7.4 rather than a defect: A had
    // already been served the purged entries before the removal and still holds them, because
    // nothing in this product can reach into a Mac that already has bytes. The relay says so
    // itself — `alreadyDeliveredIsIrrevocable: true`, asserted in §2a — and a client that claimed
    // otherwise on screen would be lying to a family about what a removal can do.
    //
    // What must be true is the pair of statements a family can rely on: neither Mac is missing
    // anything that still exists, and the ONLY difference between them is entries the removal
    // deleted. A convergence assertion that could not tell those two apart would pass on a Mac
    // that had lost half the board.
    const idsOf = (dev) => dev.state.notes.map((n) => n.id).sort();
    const onlyOnA = idsOf(A).filter((id) => !idsOf(B).includes(id));
    const onlyOnB = idsOf(B).filter((id) => !idsOf(A).includes(id));
    assert.deepEqual(onlyOnB, [],
      'B — the Mac that was shut through the removal — is missing NOTHING the other Mac has');
    assert.deepEqual(onlyOnA, ['c0', 'c1', 'c2', 'c3'],
      'and the only difference is the four entries the purge deleted, which A had already been '
      + 'served before it happened (ADR 002 §7.4: already delivered is irrevocable). Not one '
      + 'surviving entry differs.');

    // ── WHAT THE USER WAS TOLD: TRUE, AND NOT A PROMISE NOTHING CAN KEEP ────────────────────
    const words = said(B);
    assert.equal(/still owed/.test(words), false,
      'nothing told the user that rows deleted on purpose are "still owed" by a relay that cannot '
      + 'serve them. Round 8 promised a delivery that could never arrive (R8-2).');
    if (CRIED_WOLF.test(words)) {
      assert.match(words, /removed from a shared board/,
        'if the break IS mentioned, it must name the benign cause a family can act on');
      assert.match(words, /Syncing continues/, 'and say that syncing did not stop');
    }

    // ── ACROSS A RELAUNCH, WHICH IS WHERE THE DURABLE ANCHOR IS EITHER RIGHT OR A LIE ───────
    for (const dev of [A, B]) {
      await dev.close();
      await dev.open();
      await slowSync(dev, 6);
      assert.deepEqual(survives.filter((id) => !dev.state.notes.some((n) => n.id === id)), [],
        `${dev.name}: and a fresh process still has everything. The record persisted beside the `
        + 'cursor is a row that was really served, so the next session verifies FROM it instead of '
        + 're-deriving the purge as a fresh accusation (R8-1b).');
      assert.equal(dev.status().state, 'healthy', `${dev.name}: quiet after the relaunch too`);
      assert.equal(dev.quarantined().length, 0, `${dev.name}: and nothing was refused on the way`);
    }
    assert.deepEqual(idsOf(B).filter((id) => !idsOf(A).includes(id)), [],
      'still nothing missing on B after both were restarted');
    assert.deepEqual(idsOf(A).filter((id) => !idsOf(B).includes(id)), ['c0', 'c1', 'c2', 'c3'],
      'and the difference is still exactly the purged entries — a relaunch neither resurrected '
      + 'them on B nor lost anything on A');

    // ── WHAT E6 STILL OWES, WRITTEN WHERE IT CANNOT BE FORGOTTEN ────────────────────────────
    //
    // Everything above is the personal-space engine, because it is the only engine there is. The
    // family-space client E6 builds has to pass this same row with a `fsp_` id and a genuine
    // second member, and the ONE mechanism this pair could not exercise is ADR 001 §4's
    // membership stage running underneath the chain witness — a purged member is also a member
    // whose `member.set` is gone, so authz and the witness meet the same hole on the same pull.
    assert.equal(f.spaceId.startsWith('psp_'), true,
      'THIS ROW RAN ON A PERSONAL SPACE, and it says so rather than implying otherwise. When E6 '
      + 'builds the family client, §2a and §2b collapse into ONE row against an `fsp_` space with '
      + 'a real removed member; the seam between them is exactly what E6 closes. If this line ever '
      + 'goes red because the fleet mints a family space, that is the signal to do the merge.');
  });
});
