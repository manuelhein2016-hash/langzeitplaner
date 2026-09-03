// ─────────────────────────────────────────────────────────────────────────────
// E10 / LZP-1003 — THE PAIRING PASS (ADR 002 §6, F19, story 19.5)
//
// The redaction boundary has taken four rounds of fire and held every one, at zero bytes.
// Pairing and backup have had far less, and they are where the keys actually live. This file is
// the pairing half. It does NOT repeat `crypto-member-pairing.test.js` (M-P1…M-P8: substitution,
// reflection, forced secret, replay, downgrade, race, brute force, the confirmSasMatch surface)
// or `tests/fleet/pairing-mitm.test.js`. Those attack the MITM. These attack the STATE MACHINE
// and the DELIVERY — the leg that carries `RK_sig`, `RK_kex` and every epoch key the member owns,
// and the leg both earlier passes stopped short of.
//
//   E10-P1  a delivery the sender passed and the receiver refused    was SUCCEEDED — now INVERTED
//   E10-P2  an off-curve ephemeral point                             was SUCCEEDED — now INVERTED
//   E10-P3  the five-attempt cap, spent by an attacker               **SUCCEEDED** — reported
//   E10-P4  a code re-used: rid and ck are a pure function of it     FAILED — and the relay's job
//   E10-P5  the TTL on the leg that carries the keys                 FAILED — both ends
//   E10-P6  a pairing that half-completes                            FAILED — after E10-P1
//   E10-P7  what a successful pair actually proves                   the honest enumeration
//   E10-P8  pairing over a Mac that is already somebody's device     FAILED
//
// RULE 3 IS OBSERVED THROUGHOUT: no assertion below reads an engine error NAME. Outcomes are
// `PairingError.code`, which this codebase chooses, or a `PAIR_STATE` it defines.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import * as sk from '../../src/js/crypto/spacekeys.js';
import {
  createPairingSession, spacesFromKeyRing, buildPairingPayload, restorePairingPayload,
  derivePairing, sealPairBox, adoptPairedDevice,
  PAIR_STATE, PAIRING, PAIR_MSG,
} from '../../src/js/crypto/pairing.js';
import { PKCS8_P256_BYTES, SYMMETRIC_KEY_BYTES } from '../../src/js/crypto/suite.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { makeMember, mkSpaceId, mkDeviceId, outcomeOf, b64u, DAY, S } from './_member-kit.js';

/** Every state `PAIR_STATE` calls terminal. A live session is one that is not in this set. */
const TERMINAL = new Set(['delivered', 'received', 'refused', 'expired', 'burned', 'failed']);
const isTerminal = (s) => TERMINAL.has(s);

/** An injected clock. Nothing under `src/js/crypto/` may read one (ADR 005 §2). */
const clock = () => { const t = { ms: 0 }; return { t, ports: { now: () => t.ms } }; };

/** The EXISTING device's `Identity`, with the recovery pair `deliver()` needs. */
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

/** A personal ring with `n` epochs, through the REAL `KeyRing` and the REAL adapter. */
async function personalRing(n = 1) {
  const r = sk.createKeyRing();
  const id = mkSpaceId('personal');
  for (let e = 1; e <= n; e++) r.put(id, e, await sk.createSpaceKey());
  return { spaces: spacesFromKeyRing(r, { personalSpaceId: id }), id };
}

/** Both sessions, driven to the point where the human has said the digits match on both screens. */
async function pairedToConfirmed(ports, identity, spaces) {
  const A = createPairingSession(identity, spaces, ports);
  const B = createPairingSession(null, null, ports);
  const { boxA, code } = await A.beginAsExisting();
  const { boxB } = await B.answerAsNew(code, boxA);
  const a = await A.confirmExisting(boxB);
  const b = await B.confirmNew();
  assert.equal(a.sas, b.sas, 'precondition: an honest transport agrees on the digits');
  A.confirmSasMatch(true);
  B.confirmSasMatch(true);
  return { A, B, code };
}

const noise = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P1 · the delivery the sender let through and the receiver refused', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // THE ATTACK, AND WHY IT IS NOT A THEORETICAL ONE.
  //
  // `deliver()`'s own comment says it validates "under exactly the rules the far side will apply,
  // so a caller can never deliver a ring the new Mac is then obliged to reject." Four shapes walked
  // past `assertPayloadShape` and were refused by `restorePairingPayload`, and the consequences
  // were not symmetric: the sending Mac went TERMINAL `delivered` and picked up §6.3 step 9's
  // obligation to rotate its personal space to e+1, while the receiving Mac stayed LIVE in
  // `confirmed`. Two Macs, one protocol run, and no agreement about whether it was over.
  //
  // And the refusal itself broke rule 3. `restorePairingPayload`'s two bare `importKey('pkcs8')`
  // calls let the ENGINE's own error out of `session.receive()` — `DataError` / `code === 0` in
  // Node, spelled differently in WebKit — into a caller whose contract says `PairingError.code`
  // is "our own vocabulary … the ONLY thing a caller may branch on". Rule 3 does not stop
  // applying because this module was written after it was written down.
  // ───────────────────────────────────────────────────────────────────────────

  test('INVERTED — the three shapes the sender CAN check are refused before a byte is sealed', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing(2);
    const good = await buildPairingPayload({
      memberId: identity.memberId, recSig: identity.recSig, recKex: identity.recKex,
      personal: spaces.personal,
    }, ports);

    const shapes = {
      'RK_sig PKCS#8 of the wrong length': { ...good, recSigPkcs8: noise(19) },
      'RK_kex PKCS#8 of the wrong length': { ...good, recKexPkcs8: noise(200) },
      'an epoch value that is not 32 bytes': {
        ...good, personal: { ...good.personal, epochs: { ...good.personal.epochs, 1: noise(7) } },
      },
      'an epoch value that is not base64url at all': {
        ...good, personal: { ...good.personal, epochs: { ...good.personal.epochs, 2: '!!!!' } },
      },
    };

    for (const [what, payload] of Object.entries(shapes)) {
      const { A } = await pairedToConfirmed(ports, identity, spaces);
      assert.equal(
        await outcomeOf(() => A.deliver(payload)), 'payload',
        `${what}: the sender must refuse this rather than seal it`
      );
      // And the sender did NOT go terminal on its own bad argument: nothing was delivered, so
      // there is nothing to be finished about. The obligation is empty.
      assert.deepEqual(A.obligations(), {}, `${what}: a refused deliver() takes on no obligation`);
    }
  });

  test('INVERTED — the shape only the far side can check now fails with a CODE, and takes the session terminal with it', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const good = await buildPairingPayload({
      memberId: identity.memberId, recSig: identity.recSig, recKex: identity.recKex,
      personal: spaces.personal,
    }, ports);

    // 138 well-formed base64url bytes that are not a P-256 point. No length check can catch this;
    // it takes `importKey`, which is the far side's. That is the honest division of labour — the
    // question is what the far side DOES with the engine's refusal.
    const bad = { ...good, recSigPkcs8: noise(PKCS8_P256_BYTES) };
    const { A, B } = await pairedToConfirmed(ports, identity, spaces);
    const blob = await A.deliver(bad);
    assert.equal(typeof blob, 'string', 'the sender cannot tell 138 bytes of noise from a key');

    // WAS: `DataError`, `err.code === 0`, an engine name the two engines spell differently.
    assert.equal(await outcomeOf(() => B.receive(blob)), 'payload');
    // WAS: 'confirmed' — a live session, still willing to receive, opposite the terminal sender.
    assert.equal(B.state(), PAIR_STATE.failed);
    assert.equal(isTerminal(B.state()), true, 'the delivery leg must fail terminally like the other two');
  });

  test('INVERTED — restorePairingPayload never lets an engine error past its own boundary (rule 3)', async () => {
    // Driven directly, so the rule is asserted about the FUNCTION and not only about one path
    // through the session. Both key slots, independently.
    const base = {
      v: 1, memberId: 'mem_whatever',
      personal: { spaceId: mkSpaceId('personal'), epochs: { 1: noise(SYMMETRIC_KEY_BYTES) } },
    };
    const cases = [
      { ...base, recSigPkcs8: noise(PKCS8_P256_BYTES), recKexPkcs8: noise(PKCS8_P256_BYTES) },
      { ...base, recSigPkcs8: noise(PKCS8_P256_BYTES), recKexPkcs8: noise(4) },
      { ...base, recSigPkcs8: noise(1), recKexPkcs8: noise(PKCS8_P256_BYTES) },
    ];
    for (const payload of cases) {
      assert.equal(await outcomeOf(() => restorePairingPayload(payload)), 'payload');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P2 · an ephemeral point of the right LENGTH and the wrong curve', () => {
  test('INVERTED — the peer point is refused with a code, and the session goes terminal', async () => {
    const { ports } = clock();
    const { me, identity } = await existingDevice();
    const { spaces } = await personalRing();

    // `assertRawPoint` checks 65 bytes and nothing else — deliberately, because both engines
    // validate the point inside `importKey` and a hand-rolled curve check would be the weaker of
    // the two (§9.2). That is a sound decision about WHO validates and said nothing about what
    // happens to the engine's answer, which used to escape `confirmNew()` raw and leave the
    // session live in `answered`.
    const A = createPairingSession(identity, spaces, ports);
    const { code } = await A.beginAsExisting();
    const { ck, rid } = await derivePairing(code, ports);

    const offCurve = new Uint8Array(65); offCurve[0] = 0x04; offCurve.fill(0x11, 1);
    const sigRaw = new Uint8Array(65); sigRaw[0] = 0x04; sigRaw.fill(0x22, 1);
    const evilOffer = await sealPairBox(ck, PAIR_MSG.offer, rid, {
      v: 1, aEph: b64u(offCurve), aSigPub: b64u(sigRaw), aDevId: 'dev_x', memberId: me.memberId,
    }, ports);

    const B = createPairingSession(null, null, ports);
    // The offer still OPENS — it is sealed under the right `ck` — and `answerAsNew` accepts it,
    // because the length is right and nothing on this leg does scalar multiplication.
    await B.answerAsNew(code, evilOffer);
    assert.equal(B.state(), PAIR_STATE.answered);

    // WAS: `DataError` / `code === 0`, and B still in 'answered'.
    assert.equal(await outcomeOf(() => B.confirmNew()), 'protocol');
    assert.equal(B.state(), PAIR_STATE.failed);
    assert.equal(isTerminal(B.state()), true);
  });

  test('the same on the EXISTING device\'s leg — one guard, both roles', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const A = createPairingSession(identity, spaces, ports);
    const { code, rid } = await A.beginAsExisting();
    const { ck } = await derivePairing(code, ports);

    const offCurve = new Uint8Array(65); offCurve[0] = 0x04; offCurve.fill(0x33, 1);
    const p65 = () => { const x = new Uint8Array(65); x[0] = 0x04; x.fill(0x44, 1); return x; };
    const evilAnswer = await sealPairBox(ck, PAIR_MSG.answer, rid, {
      v: 1, bEph: b64u(offCurve), bSigPub: b64u(p65()), bKexPub: b64u(p65()), bDevId: 'dev_y',
    }, ports);

    assert.equal(await outcomeOf(() => A.confirmExisting(evilAnswer)), 'protocol');
    assert.equal(A.state(), PAIR_STATE.failed);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P3 · the five-attempt cap, spent by somebody who is not a typist', () => {
  test('**SUCCEEDED** — the cap is PER SESSION, so four fresh sessions absorb twenty wrong codes', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // THIS ROW IS A SUCCESS AND STAYS ONE. It is not a defect in this module — it is a fact about
    // where the budget can live, and the module's own header already says the counter is
    // "necessarily client-reported". What did NOT exist anywhere was the measurement, and
    // `PAIRING.maxFailedOpens: 5` reads, next to §6.2's "an online guessing budget is
    // meaningless", as though the five were the budget. It is not. It is the honest typist's
    // budget. An attacker's budget is `relayGetPerIpPerHour` and the relay's burn of the
    // rendezvous, and neither is in this file or reachable from it.
    //
    // The arithmetic is still overwhelming (M-P7 pays that), which is exactly why this must be
    // stated rather than left to be re-derived: the number that protects the code is not the
    // number this module counts.
    // ─────────────────────────────────────────────────────────────────────────
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();

    let absorbed = 0;
    for (let session = 0; session < 4; session++) {
      const A = createPairingSession(identity, spaces, ports);
      const { boxA } = await A.beginAsExisting();
      const B = createPairingSession(null, null, ports);
      for (let i = 0; i < 10; i++) {
        const code = await outcomeOf(() => B.answerAsNew('ZZZZZZZZZZZZ', boxA));
        if (code === 'burned') { absorbed++; break; }
        assert.equal(code, 'open_failed');
        absorbed++;
      }
      assert.equal(B.state(), PAIR_STATE.burned, 'a session does burn, and it burns terminally');
    }

    assert.equal(absorbed, 4 * PAIRING.maxFailedOpens, '20 wrong codes, against a cap that reads 5');
    assert.ok(absorbed > PAIRING.maxFailedOpens, 'the module-side cap is not a global budget');

    // And the module does not pretend otherwise: it publishes both relay numbers next to its own,
    // so a reader cannot mistake the one it enforces for the one that protects the code.
    assert.equal(PAIRING.maxFailedOpens, 5);
    assert.equal(PAIRING.relayGetPerIpPerHour, 20);
    assert.equal(PAIRING.failedRidLookupsPerIpPerMinute, 5);
    assert.equal(PAIRING.sessionsPerMemberPerHour, 10);
  });

  test('a session that burned is dead to every verb, with its own code and not a generic one', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const A = createPairingSession(identity, spaces, ports);
    const { boxA } = await A.beginAsExisting();
    const B = createPairingSession(null, null, ports);
    for (let i = 0; i < PAIRING.maxFailedOpens; i++) await outcomeOf(() => B.answerAsNew('ZZZZZZZZZZZZ', boxA));
    assert.equal(B.state(), PAIR_STATE.burned);

    // 'burned' rather than 'state': a caller told only "wrong state" would offer a retry.
    for (const verb of [
      () => B.answerAsNew('ZZZZZZZZZZZZ', boxA), () => B.confirmNew(), () => B.receive('a.b'),
    ]) assert.equal(await outcomeOf(verb), 'burned');
    assert.equal(B.attemptsRemaining(), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P4 · a code re-used', () => {
  test('FAILED here, because `rid` and `ck` are a PURE FUNCTION of the code — single use is the relay\'s', async () => {
    // The point of the row is to name where the guarantee lives. `PAIRING.singleUse` is `true`,
    // and nothing in this module enforces it or could: `derivePairing` is deterministic, so the
    // same twelve characters always name the same rendezvous and always derive the same box key.
    // A reader who saw `singleUse: true` in a client module might believe the client burns it.
    const a = await derivePairing('ABCD-EFGH-JKMN');
    const b = await derivePairing('abcdefghjkmn');   // Crockford: I/L→1, O→0, case-folded
    assert.equal(a.rid, b.rid, 'the same code is the same rendezvous, every time');
    assert.equal(PAIRING.singleUse, true, 'the parameter is stated…');

    // …and what enforces it is not here. A second session on the same code derives the same rid
    // and the same ck without complaint, because there is nothing in a pure state machine that
    // could remember the first one.
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const A1 = createPairingSession(identity, spaces, ports);
    const first = await A1.beginAsExisting();
    const A2 = createPairingSession(identity, spaces, ports);
    const second = await A2.beginAsExisting();
    assert.notEqual(first.code, second.code, 'each session mints its own 60 bits…');
    assert.notEqual(first.rid, second.rid, '…so two honest sessions never collide');
    assert.equal((await derivePairing(first.code, ports)).rid, first.rid);
  });

  test('and the SAS is what makes a replayed transcript useless anyway', async () => {
    // A captured box_A replayed into a session whose A_eph is fresh produces a B whose digits
    // cannot match anyone's. The transcript is bound into the SAS (§6.3 step 6), so a replay is
    // not a downgrade, it is a mismatch a human sees.
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const A1 = createPairingSession(identity, spaces, ports);
    const first = await A1.beginAsExisting();
    const B1 = createPairingSession(null, null, ports);
    await B1.answerAsNew(first.code, first.boxA);
    const honest = await B1.confirmNew();

    // Same code, same rid, a NEW offer from a new session: B derives a different secret.
    const A2 = createPairingSession(identity, spaces, ports);
    const replayVictim = createPairingSession(null, null, ports);
    const secondOffer = await (async () => {
      const { ck, rid } = await derivePairing(first.code, ports);
      const eph = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
      const raw = new Uint8Array(await S.exportKey('raw', eph.publicKey));
      return sealPairBox(ck, PAIR_MSG.offer, rid, {
        v: 1, aEph: b64u(raw), aSigPub: b64u(raw), aDevId: 'dev_z', memberId: identity.memberId,
      }, ports);
    })();
    void A2;
    await replayVictim.answerAsNew(first.code, secondOffer);
    const replayed = await replayVictim.confirmNew();
    assert.notEqual(replayed.sas, honest.sas, 'a replayed rendezvous produces different digits');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P5 · the 180 s window on the leg that carries the keys', () => {
  test('FAILED — the delivery and the receipt are both inside the TTL, on their own clocks', async () => {
    for (const who of ['deliver', 'receive']) {
      const { t, ports } = clock();
      const { identity } = await existingDevice();
      const { spaces } = await personalRing();
      const { A, B } = await pairedToConfirmed(ports, identity, spaces);

      if (who === 'deliver') {
        t.ms = PAIRING.ttlMs + 1;
        assert.equal(await outcomeOf(() => A.deliver()), 'expired');
        assert.equal(A.state(), PAIR_STATE.expired);
      } else {
        const blob = await A.deliver();
        t.ms = PAIRING.ttlMs + 1;
        assert.equal(await outcomeOf(() => B.receive(blob)), 'expired');
        assert.equal(B.state(), PAIR_STATE.expired);
      }
    }
  });

  test('a delivery blob captured off the relay is worthless after the window, even to the device it was for', async () => {
    // The blob is sealed under a KEK derived from two ephemerals. B holds one of them — and B's
    // own clock refuses first, so a blob left on a relay overnight does not restore an identity
    // into a Mac the next morning.
    const { t, ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const { A, B } = await pairedToConfirmed(ports, identity, spaces);
    const blob = await A.deliver();
    t.ms = PAIRING.ttlMs * 100;
    assert.equal(await outcomeOf(() => B.receive(blob)), 'expired');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P6 · a pairing that half-completes', () => {
  test('FAILED — the two ends now agree about whether it is over, in every shape of the delivery', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing(3);

    // (a) the honest completion: both terminal, both OK.
    {
      const { A, B } = await pairedToConfirmed(ports, identity, spaces);
      const restored = await B.receive(await A.deliver());
      assert.equal(A.state(), PAIR_STATE.delivered);
      assert.equal(B.state(), PAIR_STATE.received);
      assert.equal(restored.memberId, identity.memberId);
      assert.deepEqual([...restored.personal.epochs.keys()], [1, 2, 3], 'every epoch, not just the top');
    }

    // (b) the delivery never arrives. A is terminal and holds an obligation naming the peer; B is
    //     still live and can still receive, which is CORRECT — the blob may yet arrive. What is
    //     asserted is that A's obligation is explicit rather than implied.
    {
      const { A, B } = await pairedToConfirmed(ports, identity, spaces);
      await A.deliver();
      assert.equal(A.state(), PAIR_STATE.delivered);
      assert.equal(isTerminal(B.state()), false, 'B may still receive a blob that is merely late');
      const o = A.obligations();
      assert.equal(o.rotatePersonalSpaceTo, 4, '§6.3 step 9 — e+1 over the three epochs delivered');
      assert.equal(o.wrapTo.deviceId, B.newDeviceKeys().deviceId, 'and it names the device to wrap to');
    }

    // (c) the delivery arrives MALFORMED. This is the case that used to leave A terminal and B
    //     live for ever, and it is the one E10-P1 closed.
    {
      const { A, B } = await pairedToConfirmed(ports, identity, spaces);
      const good = await buildPairingPayload({
        memberId: identity.memberId, recSig: identity.recSig, recKex: identity.recKex,
        personal: spaces.personal,
      }, ports);
      const blob = await A.deliver({ ...good, recKexPkcs8: noise(PKCS8_P256_BYTES) });
      assert.equal(await outcomeOf(() => B.receive(blob)), 'payload');
      assert.equal(isTerminal(A.state()) && isTerminal(B.state()), true, 'both ends terminal');
    }

    // (d) the delivery names a DIFFERENT member than the offer did. Terminal, and it always was —
    //     this is the one malformed-delivery shape the module already handled, and the reason
    //     (c) is now consistent with it rather than an exception to it.
    {
      const { A, B } = await pairedToConfirmed(ports, identity, spaces);
      const other = await existingDevice();
      const foreign = await buildPairingPayload({
        memberId: other.identity.memberId, recSig: other.identity.recSig, recKex: other.identity.recKex,
        personal: spaces.personal,
      }, ports);
      const foreignBlob = await A.deliver(foreign);
      assert.equal(await outcomeOf(() => B.receive(foreignBlob)), 'protocol');
      assert.equal(B.state(), PAIR_STATE.failed);
    }
  });

  test('a session that has delivered cannot deliver again — the key transfer is once', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const { A } = await pairedToConfirmed(ports, identity, spaces);
    await A.deliver();
    assert.equal(await outcomeOf(() => A.deliver()), 'delivered');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P7 · what a successful pair actually proves about the other device', () => {
  test('the honest enumeration: NOTHING in pairing verifies a signature', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // THE TICKET ASKS THE QUESTION, SO IT IS ANSWERED AS A MEASUREMENT RATHER THAN A PARAGRAPH.
    //
    // A completed pairing proves exactly three things, and their conjunction:
    //   1. the far side knew the 60-bit code (it opened a box sealed under `ck`);
    //   2. a human confirmed the same six digits on both screens, which binds the ECDH transcript;
    //   3. the delivery opened under a KEK derived from that same transcript.
    //
    // It proves NOTHING by signature. `box_A` carries `aSigPub` and `memberId`, and neither is
    // ever checked against anything: `aSigPub` is hashed into a `deviceShort` for display and
    // `memberId` is compared only to ITSELF (the offer's copy against the delivery's). The thing
    // that actually makes the new Mac a device of that member is the RK_sig PRIVATE key inside
    // the delivery, and possession of it is the proof — not a signature over it.
    //
    // This is not a defect. §6.1 puts physical access and shoulder-surfing out of scope, and
    // there is nothing for a signature to be checked AGAINST: the new Mac has no roster, no log
    // and no keys. It is stated because a reader of a green pairing suite may conclude that a
    // paired device was authenticated, and it was authorised — by a human, comparing digits.
    // ─────────────────────────────────────────────────────────────────────────
    const { ports } = clock();
    const { me, identity } = await existingDevice();
    const { spaces } = await personalRing();

    // Count what the module actually asks the engine to do, across a whole successful pairing.
    const calls = [];
    const spy = new Proxy(S, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== 'function') return v;
        return (...args) => { calls.push(prop); return v.apply(target, args); };
      },
    });
    const spied = { ...ports, subtle: spy };

    const { A, B } = await pairedToConfirmed(spied, identity, spaces);
    const restored = await B.receive(await A.deliver());

    assert.equal(calls.includes('verify'), false, 'no signature is verified anywhere in a pairing');
    assert.equal(calls.includes('sign'), false, 'and none is made');
    assert.ok(calls.includes('deriveBits') && calls.includes('deriveKey'), 'the whole proof is agreement');

    // What IS proved, positively: the delivered private key is the member's, because it is the
    // key itself. Possession, not attestation.
    assert.equal(restored.memberId, me.memberId);
    assert.equal(restored.recSigPriv.type, 'private');
    assert.equal(restored.recSigPriv.extractable, true, '§7.2 — it must reach the next backup');

    // And the `memberId` in the offer was never proved to be the sender's. It is compared to the
    // delivery's copy of itself and to nothing else — which is what makes the SAS load-bearing.
    assert.equal(B.peer().memberId, me.memberId);
  });

  test('the peer record shown next to the digits is derived from UNVERIFIED bytes, and says only what it is', async () => {
    // `peer().deviceShort` is `deviceShortOf(aSigPubRaw)` — a hash of 65 bytes the far side chose.
    // It is a label for the screen, and §2.3's "a deviceId is a label, not an identity" applies to
    // this one too. Asserted so that no UI is built on it as though it were a credential.
    const { ports } = clock();
    const { me, identity } = await existingDevice();
    const { spaces } = await personalRing();
    const { B } = await pairedToConfirmed(ports, identity, spaces);
    const peer = B.peer();
    assert.equal(peer.memberId, me.memberId);
    assert.equal(typeof peer.deviceShort, 'string');
    assert.equal(peer.deviceShort.length, 16);
    // No attestation, no signature, no verification result anywhere on it.
    assert.deepEqual(
      Object.keys(peer).sort(), ['deviceId', 'deviceShort', 'memberId', 'sigPubRaw'],
      'the peer record carries no attestation and must not be read as one'
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('E10-P8 · pairing over a Mac that is already somebody\'s device', () => {
  test('FAILED — adoptPairedDevice refuses a non-empty store, and mints nothing over it', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const { A, B } = await pairedToConfirmed(ports, identity, spaces);
    const restored = await B.receive(await A.deliver());

    // A store that is already a device of some member.
    const occupied = (await makeMember()).ks;
    const before = (await occupied.list()).sort();
    assert.equal(
      await outcomeOf(() => adoptPairedDevice(occupied, restored, B.newDeviceKeys(), { createdAt: DAY, ...ports })),
      'keystore'
    );
    assert.deepEqual((await occupied.list()).sort(), before, 'and nothing was written on the way to refusing');

    // On an EMPTY store it succeeds, and the device it mints is the pair committed to at step 4 —
    // never a fresh one, because the first Mac already displayed its short next to the digits and
    // step 9 wraps the rotated PSK to its `kexPub`.
    const fresh = memKeyStore();
    const adopted = await adoptPairedDevice(fresh, restored, B.newDeviceKeys(), { createdAt: DAY, ...ports });
    assert.equal(adopted.identity.deviceShort, B.newDeviceKeys().deviceShort);
    assert.equal(adopted.identity.devSig.privateKey.extractable, false, '§2.1 — a device key never leaves');
    assert.equal(adopted.attestation.memberId, identity.memberId);
  });

  test('the restored recovery identity is the MEMBER\'s and the device identity is this MACHINE\'s (§7.3 step 3)', async () => {
    const { ports } = clock();
    const { identity } = await existingDevice();
    const { spaces } = await personalRing();
    const { A, B } = await pairedToConfirmed(ports, identity, spaces);
    const restored = await B.receive(await A.deliver());
    const adopted = await adoptPairedDevice(memKeyStore(), restored, B.newDeviceKeys(), { createdAt: DAY, ...ports });

    // Same member, different device. "A device is a machine, not a person."
    assert.equal(adopted.identity.memberId, identity.memberId);
    assert.notEqual(adopted.identity.deviceId, identity.deviceId);
    void mkDeviceId;
  });
});
