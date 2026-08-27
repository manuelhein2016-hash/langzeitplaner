// ─────────────────────────────────────────────────────────────────────────────
// T4 — THE ACTIVE MITM AT PAIRING (ADR 002 §0, §6)
//
// The relay is an active attacker: it reads, modifies, drops, replays and reorders, and it may
// run the protocol with both sides. The SAS is the stated defence — "the code is not the security
// parameter, the SAS is" (§6.4) — so the two questions worth asking are:
//
//   1. does a MITM genuinely produce DIFFERENT digits on the two ends, in every shape it has?
//   2. is there ANY path to `deliver()` or `receive()` that does not pass the comparison?
//
//   M-P1  substitute ephemeral keys                     FAILED — different digits both ends
//   M-P2  REFLECT each side's own point back at it      FAILED — different digits (new)
//   M-P3  force a shared secret / a shared SAS          FAILED — the transcript is bound too
//   M-P4  replay a transcript                           FAILED — slot, rid, TTL and state
//   M-P5  downgrade a message                           FAILED — the AAD is reconstructed
//   M-P6  RACE two pairings on one code                 FAILED — but see M-P6b (new)
//   M-P7  brute-force the code inside its TTL           FAILED — arithmetic
//   M-P8  skip the comparison                           FAILED — enumerated at the API surface
//
// `tests/tier1/crypto-pairing.test.js` already drives the five transports in `tests/helpers/
// mitm.js`. This file does NOT repeat those; it adds the shapes that file does not have — the
// reflection, the race, and an exhaustive enumeration of the paths into `deliver`/`receive`.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as sk from '../../src/js/crypto/spacekeys.js';
import {
  createPairingSession, derivePairing, openPairBox, sealPairBox, computeSas,
  PAIR_STATE, PAIRING, spacesFromKeyRing,
} from '../../src/js/crypto/pairing.js';
import { makeMember, ring, outcomeOf, mkSpaceId, S } from './_member-kit.js';

/** An `Identity` as `createPairingSession` wants it, for the EXISTING device. */
async function existingDevice() {
  const me = await makeMember();
  const d = me.devices[0];
  return {
    me,
    identity: {
      memberId: me.memberId, deviceId: d.deviceId,
      devSig: d.devSig, devKex: d.devKex,
      recSig: me.rec.recSig, recKex: me.rec.recKex,
    },
  };
}

/** A key ring with one personal epoch, which is what §6.3 step 7 delivers. Built through
 *  `spacesFromKeyRing`, the real adapter, not a stand-in for it. */
async function personalRing() {
  const r = sk.createKeyRing();
  const id = mkSpaceId('personal');
  r.put(id, 1, await sk.createSpaceKey());
  return { keyring: spacesFromKeyRing(r, { personalSpaceId: id }), id };
}

const clock = () => { const t = { ms: 0 }; return { t, ports: { now: () => t.ms } }; };

describe('T4 substitutes, reflects and forces', () => {
  test('M-P1/M-P2 FAILED — substitution AND reflection both produce different digits on the two screens', async () => {
    const { t, ports } = clock();
    const { identity } = await existingDevice();

    // The honest run first, so the divergence below means something.
    {
      const A = createPairingSession(identity, null, ports);
      const g = await A.beginAsExisting();
      const B = createPairingSession(null, null, ports);
      const ans = await B.answerAsNew(g.code, g.boxA);
      const a = await A.confirmExisting(ans.boxB);
      const b = await B.confirmNew();
      assert.equal(a.sas, b.sas);
      assert.match(a.sas, /^\d{6}$/);
    }

    // M-P2 — THE REFLECTION, which is not one of the five transports in `mitm.js`. A relay that
    // learned the code re-seals box_B carrying A's OWN ephemeral point. If the SAS were a
    // function of the shared secret alone this would be the interesting case, because A would
    // then agree with itself. It is not: §6.3 step 6's IKM is `S ‖ A_eph ‖ B_eph` as EACH SIDE
    // SAW THEM, so the two transcripts differ even where the secrets might not.
    const A = createPairingSession(identity, null, ports);
    const g = await A.beginAsExisting();
    const B = createPairingSession(null, null, ports);
    const ans = await B.answerAsNew(g.code, g.boxA);

    const { rid, ck } = await derivePairing(g.code, ports);
    const openedA = await openPairBox(ck, 'offer', rid, g.boxA, ports);
    const openedB = await openPairBox(ck, 'answer', rid, ans.boxB, ports);
    const reflected = await sealPairBox(ck, 'answer', rid, { ...openedB, bEph: openedA.aEph }, ports);

    const a = await A.confirmExisting(reflected);
    const b = await B.confirmNew();
    assert.notEqual(a.sas, b.sas, 'the reflection produced matching digits — M-P2 SUCCEEDED');

    // The human refuses on either screen and the session is terminally dead on that side.
    assert.equal(A.confirmSasMatch(false).state, PAIR_STATE.refused);
    await assert.rejects(() => A.deliver(), (err) => err.code === PAIR_STATE.refused);
    void t;
  });

  test('M-P3 FAILED — the SAS binds the whole transcript, so even a forced shared secret is not enough', async () => {
    // The strongest MITM imaginable at this seam: suppose it could somehow impose the SAME ECDH
    // secret on both sides. It would still have to make both sides agree about which two points
    // they exchanged, because both are in the IKM and both are ordered BY ROLE, never sorted.
    const shared = crypto.getRandomValues(new Uint8Array(32));
    const pt = async () => {
      const kp = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      return new Uint8Array(await S.exportKey('raw', kp.publicKey));
    };
    const a = await pt();
    const b = await pt();
    const m = await pt();
    assert.notEqual(await computeSas(shared, a, b), await computeSas(shared, a, m));
    assert.notEqual(await computeSas(shared, a, b), await computeSas(shared, m, b));
    // …and the order is by role, so swapping the two is a different SAS, not the same one.
    assert.notEqual(await computeSas(shared, a, b), await computeSas(shared, b, a));
  });
});

describe('T4 replays, downgrades and races', () => {
  test('M-P4/M-P5 FAILED — a captured box is bound to its slot and its rendezvous, and the AAD is never read off the wire', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const A = createPairingSession(identity, null, ports);
    const g = await A.beginAsExisting();
    const B = createPairingSession(null, null, ports);
    const ans = await B.answerAsNew(g.code, g.boxA);
    const { rid, ck } = await derivePairing(g.code, ports);

    // slot confusion — box_A served where box_B is expected, and back
    assert.equal(await openPairBox(ck, 'answer', rid, g.boxA, ports), null);
    assert.equal(await openPairBox(ck, 'offer', rid, ans.boxB, ports), null);
    // rendezvous confusion — the right slot, another rid
    const A2 = createPairingSession(identity, null, ports);
    const g2 = await A2.beginAsExisting();
    const { rid: rid2, ck: ck2 } = await derivePairing(g2.code, ports);
    assert.equal(await openPairBox(ck2, 'offer', rid2, g.boxA, ports), null);
    assert.equal(await openPairBox(ck, 'offer', rid, g2.boxA, ports), null);
    // a version the receiver does not know is a refusal, not a negotiation
    const downgraded = await sealPairBox(ck, 'answer', rid, { ...await openPairBox(ck, 'answer', rid, ans.boxB, ports), v: 0 }, ports);
    assert.equal(await outcomeOf(() => A.confirmExisting(downgraded)), 'version');
    assert.equal(A.state(), PAIR_STATE.failed);
  });

  test('M-P6 FAILED — two new devices race one code: the existing Mac answers exactly one, and the loser\'s digits do not match', async () => {
    // The relay serves box_A to two devices at once — the shape a hostile Wi-Fi actually has when
    // the attacker is also in the room's guest network. Both derive `ck`, both open the offer,
    // both answer. The question is whether the EXISTING Mac can be made to run two SAS states.
    const { ports } = clock();
    const { identity } = await existingDevice();
    const A = createPairingSession(identity, null, ports);
    const g = await A.beginAsExisting();

    const B1 = createPairingSession(null, null, ports);
    const B2 = createPairingSession(null, null, ports);
    const a1 = await B1.answerAsNew(g.code, g.boxA);
    const a2 = await B2.answerAsNew(g.code, g.boxA);
    assert.notEqual(a1.boxB, a2.boxB, 'two independent new devices');

    const first = await A.confirmExisting(a1.boxB);
    // The second answer cannot be processed: role and state are locked, `offered` is gone.
    assert.equal(await outcomeOf(() => A.confirmExisting(a2.boxB)), 'state');

    const s1 = (await B1.confirmNew()).sas;
    const s2 = (await B2.confirmNew()).sas;
    assert.equal(s1, first.sas, 'the winner agrees');
    assert.notEqual(s2, first.sas, 'the loser shows different digits — the human refuses');

    // M-P6b — WHAT THE RACE DOES BUY, stated because it is real and small: the losing device has
    // already MINTED its device keys and published them in box_B before any human looked. Nothing
    // secret leaks (they are public halves), and the loser can never be delivered to, but a relay
    // can therefore harvest an unbounded number of well-formed `B_sigPub`/`B_kexPub` pairs from
    // one code within one TTL. They are useless without an attestation, which needs `RK_sig`.
    assert.notEqual(B2.newDeviceKeys(), null);
    assert.equal(B2.newDeviceKeys().devSig.privateKey.extractable, false);
    await assert.rejects(() => B2.receive('x.y'), (err) => err.code === 'state');
  });

  test('M-P7 FAILED — the online guessing budget inside one TTL is arithmetic and it is negligible', () => {
    // `rid` is derived from the WHOLE 12-character code, so an attacker who never saw it must
    // guess a 60-bit value. The window is 180 s and the rendezvous burns after 5 failed opens.
    assert.equal(PAIRING.codeChars, 12);
    assert.equal(PAIRING.ttlSeconds, 180);
    assert.equal(PAIRING.maxFailedOpens, 5);
    const space = 2 ** 60;
    assert.ok(PAIRING.maxFailedOpens / space < 1e-17);
    // And the SAS is what an attacker who DOES hold the code still has to beat, at 10^-6 per
    // attempt, with no offline path — it must commit before the human looks.
    assert.equal(PAIRING.sasDigits, 6);
  });
});

describe('T4 tries to skip the comparison', () => {
  test('M-P8 FAILED — every path into deliver() and receive() passes confirmSasMatch(true), and nothing else is truthy enough', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { keyring } = await personalRing();

    // (a) Deliver before any confirmation at all.
    {
      const A = createPairingSession(identity, keyring, ports);
      const g = await A.beginAsExisting();
      const B = createPairingSession(null, null, ports);
      const ans = await B.answerAsNew(g.code, g.boxA);
      assert.equal(await outcomeOf(() => A.deliver()), 'state');      // still `offered`
      await A.confirmExisting(ans.boxB);
      assert.equal(await outcomeOf(() => A.deliver()), 'state');      // now `sas`, still refused
    }

    // (b) Every non-`true` answer, one at a time. There is no default and no truthiness.
    for (const answer of [undefined, null, false, 0, 1, 'ja', 'true', {}, [], NaN]) {
      const A = createPairingSession(identity, keyring, ports);
      const g = await A.beginAsExisting();
      const B = createPairingSession(null, null, ports);
      const ans = await B.answerAsNew(g.code, g.boxA);
      await A.confirmExisting(ans.boxB);
      assert.equal(A.confirmSasMatch(answer).state, PAIR_STATE.refused, `${String(answer)} was accepted`);
      assert.equal(await outcomeOf(() => A.deliver()), PAIR_STATE.refused);
      // …and the refusal is terminal: re-asking with `true` does not revive it.
      assert.equal(await outcomeOf(() => A.confirmSasMatch(true)), PAIR_STATE.refused);
    }

    // (c) The NEW device gates independently. A relay that gets A's human to confirm still has to
    //     get B's human to confirm before `receive` will open the delivery.
    {
      const A = createPairingSession(identity, keyring, ports);
      const g = await A.beginAsExisting();
      const B = createPairingSession(null, null, ports);
      const ans = await B.answerAsNew(g.code, g.boxA);
      await A.confirmExisting(ans.boxB);
      await B.confirmNew();
      A.confirmSasMatch(true);
      const blob = await A.deliver();
      assert.equal(await outcomeOf(() => B.receive(blob)), 'state');
      B.confirmSasMatch(true);
      const restored = await B.receive(blob);
      assert.equal(restored.memberId, identity.memberId);
    }

    // (d) The one thing no API can do, said out loud so nobody reports it as closed: this is a
    //     BOOLEAN, and a build that hard-codes `confirmSasMatch(true)` has removed the only MITM
    //     defence in the product. What the seam buys is that the lie is one greppable line.
    const src = createPairingSession.toString();
    assert.match(src, /humanSaidTheDigitsMatch !== true/);
  });
});
