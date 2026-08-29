// FLEET · LZP-505 / LZP-1005 — THE HARNESS ITSELF, AND THE HOSTILE RELAY.
//
// Three jobs, in order of how much everything else depends on them:
//
//   §1  THE FLEET IS REAL. Two genuinely distinct durable identities, brought together by the
//       SHIPPED pairing protocol over `tests/helpers/mitm.js`'s honest relay — and the same
//       protocol driven through mitm.js's ACTIVE attacker, which must fail to bootstrap the
//       second Mac at all. A fleet suite whose devices are one identity in two costumes proves
//       nothing (FINDINGS A3-H4), so this is asserted before anything else is claimed.
//
//   §2  THE RELAY CAN BE HOSTILE AND IT CHANGES NOTHING BUT LATENCY. ADR 003 §3.3: "`seq` is a
//       transport cursor and never a merge input. A server that assigns out of stamp order,
//       re-delivers, or delays cannot cause divergence — only latency." And ADR 002 §5.1: the AAD
//       binds `v, sp, ep, dv, oid, wit`, so a relabelled, re-attributed, spliced or tampered
//       envelope must fail CLOSED — costing that op and never the batch, the log or the board.
//
//   §3  DEFECT E5-1, MEASURED. The fleet found it; it is registered here rather than hidden, with
//       the exact reproduction and the exact cost.
//
// `tests/helpers/fleet.js`'s header is the honest inventory of what is real here and what is
// stood in for. Read it before adding a case.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree, registerDigest, MUTATORS, chainMutators, simClock } from '../helpers/fleet.js';
import { activeMitm, blindMitm, drivePairing, honestRelay } from '../helpers/mitm.js';
import { createPairingSession } from '../../src/js/crypto/pairing.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { openDeviceIdentity } from '../../src/js/platform/device-identity.js';
import { createSpaceKey, createKeyRing } from '../../src/js/crypto/spacekeys.js';
import { verifyChain } from '../../src/js/sync/chain.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2027-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b0', startDate: '2027-07-01', endDate: '2027-07-14', label: 'Urlaub', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: { '2027-03': 'Notizen' },
  settings: null,
});

const twoMacs = (over = {}) => createFleet({ board: BOARD(), devices: ['A', 'B'], ...over });

function onlyE51(...devices) {
  for (const d of devices) {
    assert.deepEqual(d.realQuarantine(), [],
      `${d.name}: a quarantine that is not E5-1 — ${JSON.stringify(d.realQuarantine())}`);
  }
}

/** Four edits on A, pushed. The set every §2 case is measured against. */
async function scenario(f) {
  await f.A.apply('editNotePopover', { id: 'n0', text: 'eins' });
  await f.A.apply('createNotePopover', { id: 'n1', date: '2027-04-04', text: 'zwei', categoryId: 'c1' });
  await f.A.apply('editNotePopover', { id: 'n0', text: 'drei' });
  await f.A.apply('editBarLabel', { id: 'b0', label: 'Sommerurlaub' });
  await f.A.push();
}

/** What an honest B ends up with. Every hostile run is compared against exactly this. */
function expectedBoard(d) {
  assert.equal(d.state.notes.find((n) => n.id === 'n0').text, 'drei');
  assert.equal(d.state.notes.find((n) => n.id === 'n1').text, 'zwei');
  assert.equal(d.state.bars[0].label, 'Sommerurlaub');
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE FLEET IS REAL
// ═════════════════════════════════════════════════════════════════════════════

describe('§1 · two Macs, and the pairing that made them one member', () => {
  test('the second Mac minted its OWN keys and was let in by a SAS-confirmed pairing', async () => {
    const f = await twoMacs();
    assert.notEqual(f.A.keys.ks, f.B.keys.ks, 'two key stores');
    assert.notEqual(f.A.keys.identity.devSig, f.B.keys.identity.devSig, 'two signing key objects');
    assert.equal(f.A.keys.identity.devSig.privateKey.extractable, false,
      'a device signing key is never extractable (ADR 002 §2.1) — a signature is the only thing '
      + 'that can cross the boundary, which is why net.js takes a `sign` PORT');
    assert.equal(f.B.keys.identity.devSig.privateKey.extractable, false);
    assert.equal(f.A.memberId, f.B.memberId, 'one member: M1 is one person with two Macs');
    assert.equal(await f.assertDistinctIdentities(), true);
  });

  test('an ACTIVE MITM on the pairing rendezvous cannot bootstrap a second Mac (ADR 002 §6.4)', async () => {
    // `tests/helpers/mitm.js` re-implements every primitive against raw WebCrypto rather than
    // importing `pairing.js`, so an attacker built out of the victim's helpers cannot hide a bug
    // in them. The attacker is GIVEN the code — a shoulder-surf — because the SAS is supposed to
    // hold even then. At fleet scale the consequence is the one that matters: the fleet cannot be
    // formed, so there is never a second device to converge with.
    const clock = simClock();
    const ks = memKeyStore();
    const me = await openDeviceIdentity(ks, { today: clock.today(), allowMemoryCustody: true });
    const spaceKey = await createSpaceKey();
    const ring = createKeyRing([['psp_AAAAAAAAAAAAAAAAAAAAAA', 1, spaceKey]]);
    const sessions = () => ({
      A: createPairingSession(
        { ...me.identity, recSig: me.recovery.recSig, recKex: me.recovery.recKex },
        { personal: { spaceId: 'psp_AAAAAAAAAAAAAAAAAAAAAA', epochs: ring.keysByEpoch('psp_AAAAAAAAAAAAAAAAAAAAAA') }, family: null },
        { now: clock.now },
      ),
      B: createPairingSession(null, null, { now: clock.now }),
    });

    const honest = await drivePairing({ ...sessions(), transport: honestRelay({ now: clock.now }) });
    assert.equal(honest.error, null, 'the control: an honest relay pairs');
    assert.equal(honest.sasMatched, true);
    assert.ok(honest.restored, 'and the new Mac really received the ring');

    let code = null;
    const attacked = await drivePairing({
      ...sessions(),
      transport: activeMitm({ code: () => code, now: clock.now }),
      learnCode: (c) => { code = c; },
    });
    assert.notEqual(attacked.sasA, attacked.sasB,
      'the two Macs must SEE DIFFERENT DIGITS — that is the whole of §6.4');
    assert.notEqual(attacked.sasMatched, true, 'so the human refuses, and nothing is delivered');
    assert.equal(attacked.restored, null, 'the attacker got no key ring into the new Mac');

    const blind = await drivePairing({ ...sessions(), transport: blindMitm({ flip: 'offer' }) });
    assert.equal(blind.restored, null, 'and a relay that can only corrupt fails closed');
    assert.notEqual(blind.error, null, 'loudly, not silently');
  });

  test('each Mac holds its OWN board.json, checkpoint and ops.jsonl', async () => {
    const f = await twoMacs();
    for (const d of f.all) {
      assert.ok(d.diskKeys().includes('langzeitplaner.board'), `${d.name} has a board`);
      assert.ok(d.diskKeys().includes('langzeitplaner.checkpoint'), `${d.name} has a durable log`);
    }
    f.A.disk.setItem('probe', 'A');
    assert.equal(f.B.disk.getItem('probe'), null, 'and the disks are not the same object');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE HOSTILE RELAY
// ═════════════════════════════════════════════════════════════════════════════

describe('§2a · a relay that reorders, duplicates or delays changes latency and nothing else', () => {
  for (const [name, mutator] of [
    ['serves every page backwards', MUTATORS.reverseOps()],
    ['serves every op twice', MUTATORS.duplicateOps()],
    ['shuffles the page (seed 11)', MUTATORS.shuffleOps(11)],
    ['shuffles AND doubles', chainMutators(MUTATORS.shuffleOps(5), MUTATORS.duplicateOps())],
    ['reverses AND doubles AND shuffles', chainMutators(MUTATORS.reverseOps(), MUTATORS.duplicateOps(), MUTATORS.shuffleOps(2))],
  ]) {
    test(`a relay that ${name}`, async () => {
      const f = await twoMacs();
      await scenario(f);
      f.wire.hostile.onResponse = mutator;
      await f.B.sync();
      f.wire.honest();
      expectedBoard(f.B);
      const agree = boardsAgree([f.A, f.B]);
      assert.equal(agree.equal, true, `${name}: ${agree.detail}`);
      onlyE51(f.B);
    });
  }

  test('a relay that withholds ops from ONE Mac takes them PERMANENTLY — and only the chain can see it', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // THE ONE LIE THE PAYLOAD CANNOT EXPOSE, and v2 accepts it knowingly.
    //
    // A relay that drops ops from a page and still reports a `nextCursor` past them takes those
    // ops from that Mac for ever: the client has nothing to compare against, the merge is
    // set-based so nothing looks wrong, and ADR 002 §8.6 / ADR 003 §10.6 make the chain witness
    // DIAGNOSTIC-ONLY in v2 — it never blocks a sync. This test is the measurement of that trade,
    // aimed at ONE victim (the third argument every mutator receives) so the result is a genuine
    // DIVERGENCE between two Macs rather than a shared error.
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    const f = await twoMacs();
    await scenario(f);
    const victim = f.B.short;
    let lied = 0;
    f.wire.hostile.onResponse = (res, req, who) => {
      if (who !== victim) return res;                       // A is told the truth …
      lied += 1;
      return MUTATORS.withholdOps((o) => o.oid === f.A.logOps().find((x) => x.f && x.f.text === 'zwei').id)(res, req);
    };
    await f.B.sync();
    f.wire.honest();
    await f.B.sync();
    await f.A.sync();
    assert.ok(lied >= 1, 'the adversary was actually armed');

    assert.equal(f.B.state.notes.find((n) => n.id === 'n1'), undefined,
      'the withheld op is GONE from this Mac and an honest relay afterwards does not bring it back — '
      + 'the cursor was advanced over it by the relay\'s own nextCursor');
    assert.equal(f.A.state.notes.find((n) => n.id === 'n1').text, 'zwei', 'while the other Mac has it');
    assert.equal(boardsAgree([f.A, f.B]).equal, false, 'so the two Macs are permanently divergent');
    assert.equal(f.B.status().state, 'healthy',
      'and the engine reports HEALTHY, because nothing in the payload could have told it otherwise');

    // …and this is precisely what `src/js/sync/chain.js` exists to see. ADR 003 §3.3 makes `seq`
    // gapless per space, so a withheld op is a HOLE, and the hole is provable without any key.
    const page = await f.A.run(() => f.A.transport.request(
      'GET', '/api/v1/ops', { space: f.spaceId, since: '0' }, null,
    ));
    const all = page.json.ops.map((o) => ({ seq: o.seq, chain: o.chain, env: { oid: o.oid } }));
    const holed = all.filter((r) => r.env.oid !== f.A.logOps().find((x) => x.f && x.f.text === 'zwei').id);
    const whole = await verifyChain(all, null);
    const gapped = await verifyChain(holed, null);
    assert.equal(whole.ok, true, 'the honest page verifies …');
    assert.equal(gapped.ok, false, '… and the censored one does not');
    assert.ok(gapped.findings.some((x) => x.kind === 'gap' || /gap/i.test(x.kind || '')),
      `the finding must name the hole: ${JSON.stringify(gapped.findings.map((x) => x.kind))}`);
  });

  test('a relay that rewinds the cursor for ever cannot make the client lose or double anything', async () => {
    const f = await twoMacs();
    await scenario(f);
    f.wire.hostile.onResponse = MUTATORS.rewindCursor();
    await f.B.sync();                     // bounded by the client, not by the adversary
    const midway = registerDigest(f.B);
    f.wire.honest();
    await f.B.sync();
    expectedBoard(f.B);
    assert.equal(Object.keys(midway).length > 0, true, 'it did fold what it was given');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });
});

describe('§2b · the AAD half — a relabelled or tampered envelope fails CLOSED', () => {
  /**
   * ADR 002 §5.1's AAD binds `v, sp, ep, dv, oid, wit`, so re-attributing, epoch-relabelling,
   * space-relabelling and splicing an envelope are ALL the same event to `openOp`: the signature
   * no longer verifies under the key named by `dv`, and P3 throws before a single byte is
   * decrypted. The four attacks below are therefore worth running SEPARATELY not because they
   * fail differently but because a reader has to be able to see that they all reach the same
   * gate — §5.1's own sentence, "this is also what a re-attributed, epoch-relabelled or spliced
   * envelope looks like", made executable.
   *
   * Each case asserts the same four things, because what matters is not "did it reject" but
   * WHAT THE REJECTION COST:
   *   1. the board did not move;
   *   2. the LOG was not quarantined — one hostile op may not cost a Mac its history;
   *   3. the op is quarantined BY NAME, so the failure is visible (ADR 003 §8.3 `error`);
   *   4. and — measured, not assumed — the cursor is RELEASED past it, so the op is gone for good.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * FINDING E5-4, and it is a DESIGN QUESTION rather than a bug: a P3 failure is terminal here.
   * `sync/personal.js` defers a `park` on `attestation` or `epoch` for `maxDeferrals` attempts
   * (F-6) but treats an `EnvelopeError` as final on the first try, and then advances the cursor.
   * That honours ADR 003 §8.2 ("a permanently rejected op must never silently spin forever"), and
   * the price is that a TRANSIENT hostile or broken relay costs one Mac an op permanently and
   * one-sidedly, with no path back — because ADR 002 §5.4 makes the chain witness diagnostic-only,
   * nothing downstream ever notices. Both halves are defensible; the trade is written down
   * nowhere. `CURABLE_PARKS` is the natural home for the answer.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  const cases = [
    ['a flipped ciphertext byte', (f) => MUTATORS.tamperCiphertext(0), /P3|aead/],
    ['every op re-attributed to the receiver', (f) => MUTATORS.reattribute(f.B.short), /P3/],
    ['every op relabelled into epoch 99', () => MUTATORS.relabelEpoch(99), /P3/],
    ["two ops spliced under each other's ids", () => MUTATORS.spliceOid(), /P3/, true],
    ['every op relabelled into a FAMILY space (21.2)', () => MUTATORS.relabelSpace('fsp_AAAAAAAAAAAAAAAAAAAAAA'), /P3/],
  ];

  for (const [name, make, reason, needsTwo] of cases) {
    test(`${name} costs that op and nothing else`, async () => {
      const f = await twoMacs();
      // ONE op unless the attack needs two. `spliceOid` swaps two ids and is a no-op on a page of
      // one — so it gets a second op, and `tamperCiphertext(0)` would then only touch the first,
      // which is why every other case stays at one and "the board did not move" is unambiguous.
      await f.A.apply('editNotePopover', { id: 'n0', text: 'drei' });
      if (needsTwo) await f.A.apply('editBarLabel', { id: 'b0', label: 'Sommerurlaub' });
      await f.A.push();
      const boardBefore = f.B.boardContent();
      const digestBefore = registerDigest(f.B);

      f.wire.hostile.onResponse = make(f);
      await f.B.sync();
      f.wire.honest();

      assert.deepEqual(f.B.boardContent(), boardBefore, `${name}: the board moved`);
      assert.deepEqual(registerDigest(f.B), digestBefore, `${name}: a register cell moved`);
      assert.equal(f.B.storeDiagnostics().quarantine, null,
        `${name}: one hostile op quarantined the whole LOG`);
      const q = f.B.realQuarantine();
      assert.equal(q.length, needsTwo ? 2 : 1,
        `${name}: expected the mutated ops to be quarantined, got ${JSON.stringify(q)}`);
      for (const row of q) assert.match(row.reason, reason, `${name}: refused by the wrong gate`);
      assert.equal(f.B.status().state, 'error', 'and the engine SAYS so — never silently (19.3)');
      assert.equal(f.B.status().errorKind, 'quarantine');

      // E5-4, measured: an honest relay afterwards does NOT bring it back.
      await f.B.sync();
      assert.equal(f.B.state.notes.find((n) => n.id === 'n0').text, 'Zahnarzt',
        `${name}: E5-4 — the cursor was released past the refused op, so it never returns. `
        + 'Invert this line if `CURABLE_PARKS` ever grows a P3 entry.');
      // …and the fleet is not wedged: the next edit still crosses.
      await f.A.apply('createNotePopover', { id: 'danach', date: '2027-05-05', text: 'danach', categoryId: 'c1' });
      await f.settle();
      assert.equal(f.B.state.notes.find((n) => n.id === 'danach').text, 'danach',
        `${name}: one refused op wedged the stream`);
    });
  }

  test('a forged device row on the pull piggyback grants nothing (`the log is the authority`)', async () => {
    // `handlers/members.js` withholds `Device.attestation` on purpose, precisely so a malicious
    // relay cannot fabricate a device for an existing member. This drives that: a row naming a
    // plausible short beside envelopes re-attributed to it. The row is a HINT about who to wrap
    // to and never a credential, so it admits nothing.
    const f = await twoMacs();
    await f.A.apply('editNotePopover', { id: 'n0', text: 'drei' });
    await f.A.push();
    const boardBefore = f.B.boardContent();
    f.wire.hostile.onResponse = chainMutators(
      MUTATORS.forgeDeviceRow({
        deviceShort: 'ZZZZZZZZZZZZZZZZ',
        sigPubRaw: 'BA'.padEnd(86, 'A'),
        kexPubRaw: 'BA'.padEnd(86, 'A'),
        revokedAt: null,
      }),
      MUTATORS.reattribute('ZZZZZZZZZZZZZZZZ'),
    );
    await f.B.sync();
    f.wire.honest();
    assert.deepEqual(f.B.boardContent(), boardBefore,
      'the relay named a device and signed nothing — no attestation, no admission');
    assert.equal(f.B.storeDiagnostics().quarantine, null);
  });

  test('a relay that answers 200 with an empty page cannot be told from silence — and costs nothing', async () => {
    // The ONE lie the payload cannot expose (ADR 002 §5.4, and the witness is diagnostic-only in
    // v2). What the client CAN guarantee is that it never advances its cursor past what it was
    // given — `nextCursor` is the seq of the last op ACTUALLY RETURNED — so withholding costs
    // latency and nothing more.
    const f = await twoMacs();
    await scenario(f);
    f.wire.hostile.onResponse = chainMutators(
      MUTATORS.withholdOps(() => true),
      // A relay that withholds is free to lie about the cursor too, and the ONE thing that
      // decides whether the client recovers is whether it is told to move past what it never
      // got. Held here, so the recovery half is what is measured; the other half — a relay that
      // advances the cursor over a hole — is the test above, and it does not recover.
      MUTATORS.rewindCursor(),
    );
    const cursorBefore = f.B.cursor();
    await f.B.sync();
    assert.equal(f.B.state.notes.find((n) => n.id === 'n1'), undefined, 'B saw nothing …');
    assert.equal(f.B.cursor(), cursorBefore, '… and was not moved past what it was not given');
    assert.notEqual(f.B.status().state, 'error', 'and it has no way to know, which is honest');

    f.wire.honest();
    await f.B.sync();
    expectedBoard(f.B);
    assert.equal(boardsAgree([f.A, f.B]).equal, true, 'everything arrives when the relay stops');
    onlyE51(f.B);
  });

  test('a 429 and a 5xx stop the loop without losing the queue', async () => {
    const f = await twoMacs();
    await f.B.apply('createNotePopover', { id: 'warte', date: '2027-08-08', text: 'wartet', categoryId: 'c1' });
    const queued = f.B.outboxSize();
    assert.ok(queued >= 1);

    for (const [status, body, headers] of [
      [429, { error: 'rate_limited' }, { 'Retry-After': '30' }],
      [503, { error: 'internal' }, {}],
    ]) {
      f.wire.hostile.onResponse = MUTATORS.forceStatus(status, body, headers);
      await f.B.sync();
      assert.equal(f.B.outboxSize(), queued, `${status}: the queue must survive`);
      assert.equal(f.B.state.notes.find((n) => n.id === 'warte').text, 'wartet',
        `${status}: principle 6 — a transport failure never removes an entry from the board`);
    }
    f.wire.honest();
    await f.settle();
    assert.equal(f.A.state.notes.find((n) => n.id === 'warte').text, 'wartet');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. DEFECT E5-1, MEASURED RATHER THAN HIDDEN
// ═════════════════════════════════════════════════════════════════════════════

describe('§3 · E5-1 CLOSED — the spine is prehistory, not traffic', () => {
  test('two Macs migrating one board.json never collide on `409 forked_op_id`', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // THE DEFECT THIS FLEET FOUND, AND ITS CLOSURE.
    //
    // `deriveOpId(index, kind, key)` is a pure function of `board.json` (ADR 001 §8.1), so two
    // Macs over one file mint the SAME migration opIds — deliberately. If the spine were then
    // offered to the outbox, one of two things had to happen and both were wrong:
    //   · un-restamped, `sealOp` refuses every one on ADR 002 §5.2.2 check 4 (the GENESIS stamp
    //     carries the all-zeros device short), so the whole board is quarantined line by line;
    //   · re-stamped, the ids still collide while the BYTES differ, so the second Mac's very
    //     first push is `409 forked_op_id` — for ever, with a stuck outbox line and story 19.3's
    //     `error` indicator lit on day one for every M1 user with two healthy Macs.
    // `store.outbox()` now excludes GENESIS-stamped lines, which is the third answer and the
    // right one: **the spine does not travel, because §8.1's determinism means it does not have
    // to.** These assertions are that closure; each one goes red for one of the two old paths.
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    const f = await twoMacs();

    // The ids DO collide — §8.1 working, and the reason the outbox must not offer them.
    const migA = f.A.logOps().filter((o) => o.ts.endsWith('0000000000000000'));
    const migB = f.B.logOps().filter((o) => o.ts.endsWith('0000000000000000'));
    assert.ok(migA.length >= 4, `the spine exists: ${migA.length} migrated ops`);
    assert.deepEqual(migA.map((o) => o.id).sort(), migB.map((o) => o.id).sort(),
      'two Macs over one board.json mint the SAME migration opIds — ADR 001 §8.1 working');
    assert.deepEqual(migA.map((o) => o.ts).sort(), migB.map((o) => o.ts).sort(),
      'and the SAME stamps, so the bytes would be identical too');

    // And none of them is offered to the wire.
    assert.deepEqual(f.A.store.outbox(), [], 'the spine is not in the outbox …');
    assert.deepEqual(f.B.store.outbox(), []);
    const pa = await f.A.push();
    const pb = await f.B.push();
    assert.equal(pa.pushed, 0);
    assert.equal(pb.pushed, 0, '… so neither Mac uploads it, and there is nothing to collide');
    assert.deepEqual(f.B.quarantined(), [], 'no `forked_op_id`, on either Mac');
    assert.deepEqual(f.A.quarantined(), []);
    assert.equal(f.A.status().state, 'healthy', 'and both Macs are HEALTHY — 19.3, on day one');
    assert.equal(f.B.status().state, 'healthy');

    // The board still converges, which is the point: what travels is the EDITS.
    await f.A.apply('editNotePopover', { id: 'n0', text: 'trotzdem' });
    await f.settle();
    assert.equal(f.B.state.notes.find((n) => n.id === 'n0').text, 'trotzdem');
    assert.equal(boardsAgree([f.A, f.B]).equal, true);
  });

  test('THE COROLLARY, OWED: a Mac that does NOT hold the board.json receives none of it', async () => {
    // The price of "the spine does not travel". ADR 002 §6.3 step 8 has a freshly paired Mac
    // "pull from seq 0" — and seq 0 contains no spine, because no Mac ever pushed one. So the
    // pre-space board has to arrive out of band: through pairing, or through the backup file
    // (ADR 002 §7.2). Until that hand-over exists, a genuinely new second Mac opens on an empty
    // board and story 19.4 ("my whole private board, on both Macs") is not delivered.
    //
    // `seedAll: false` is the un-papered configuration, and this is what it measures.
    const f = await createFleet({ board: BOARD(), devices: ['A', 'B'], seedAll: false });
    await f.settle();
    assert.equal(f.A.state.notes.length, 1, 'A has the board it started from');
    assert.equal(f.B.state.notes.length, 0,
      'B received NONE of it — the corollary, measured. Invert this line the day pairing (or the '
      + 'backup file) hands the board over.');

    // What DOES cross is everything authored after the space existed, in both directions.
    await f.A.apply('createNotePopover', { id: 'neu', date: '2027-09-09', text: 'nach dem Raum', categoryId: 'c1' });
    await f.settle();
    assert.equal(f.B.state.notes.find((n) => n.id === 'neu').text, 'nach dem Raum');
  });

  test('nothing is ever quarantined on an honest run', async () => {
    // The non-vacuity control for `onlyE51()`, which every other test in this suite leans on.
    const f = await twoMacs();
    await scenario(f);
    await f.settle();
    for (const d of f.all) {
      assert.deepEqual(d.quarantined(), [], `${d.name} quarantined something on an honest run`);
      assert.equal(d.status().state, 'healthy', `${d.name} is not healthy`);
    }
  });
});
