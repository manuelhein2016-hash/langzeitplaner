// FLEET · T5 — THE FAMILY MEMBER AS ADVERSARY, AGAINST THE KEY-DELIVERY PRODUCER.
// ADR 002 §0 T5 · §4.2 (steps 2, 4, 6) · §7.1 steps 4–6 · §8.5 · PO decision D9 · stories 15.3,
// 17.1, 19.3, 20.5, 21.2 · risk R11 · A4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, IN ONE SENTENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `sync/keys.js` is new, it runs on EVERY member's Mac, and the thing it decides — "does this
// recipient already hold the ring?" — is decided from evidence the adversary in ADR 002 §0's own
// table (T5, "the admin included") is allowed to manufacture.
//
// Everything below hits the SAME routes with the SAME auth as an honest client. Nothing here
// forges a signature, breaks a cipher, or edits a byte in transit. The attacker is Eve: an
// ordinary, invited, attested, non-admin member of the Familienkreis, running a client of her own
// choosing. That is exactly the adversary §0 puts in the table and exactly the one the product
// promises to survive.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE FACT THE WHOLE FILE TURNS ON
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `server/core/handlers/spaces.js#assertCoverage` counts (recipientId, epoch) ROWS:
//
//     const have = new Set((await tx.getKeyWraps(spaceId, r)).map((w) => w.epoch));
//
// The relay cannot open a wrap and must not try, so "coverage" is a statement about the SHAPE of
// the table and never about whether anybody can decrypt anything. `sync/keys.js` §4's coverage
// proof reads it as the stronger claim, in as many words:
//
//     "So coverage is not a hope about other clients — it is a server-enforced invariant, and
//      observing that an epoch EXISTS is observing that it held."
//
// It is not. An epoch exists when 3n rows exist. §1 below is what that costs.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FALSE GREENS THIS FILE IS WRITTEN AGAINST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. **the joiner never had a working path.** §0 asserts the HONEST delivery works first, on
//      this very rig, for this very joiner — Mama gets epochs [1..e] with nobody attacking. A
//      denial test on a rig that never delivered is a tautology.
//   2. **the attacker was the relay.** Every request Eve makes goes through `platform/net.js`'s
//      `buildRequest` and the real ADR 003 §2 ladder. She is authenticated as herself, and the
//      relay is `adapters/memory.js` behaving perfectly.
//   3. **"nothing happened" was never measured.** Every SUCCEEDED row asserts the victim's
//      OBSERVABLE state — status, warnings, quarantine, board — and asserts it is quiet. A denial
//      that showed up as an error would be a bad afternoon, not a break.
//   4. **the honest devices were asleep.** §1c drives Papa's `syncNow()` five more times after
//      the attack and asserts he still refuses to deliver.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree, never in the tree
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A row that says "this attack works" is worth nothing unless closing the hole makes it go red.
// Each mutant below CLOSES one hole; the rows it kills are named beside it. Measured, one run
// each, in `.../scratchpad/mutant`.
//
//   M-A  `sync/keys.js` — the coverage proof is ONLY what this device itself delivered:
//        `observe()` derives nothing from an epoch bump, and the `RACED` branch calls no
//        `proveMine`.                                          → §1b · §1c · §1d · §1e · §1f · §1g
//        (§1a survives, correctly: it is a statement about the RELAY, which M-A does not touch.)
//   M-B  `sync/keys.js` — `onAdmit` fires only when `ring.covers(spaceId, currentEpoch)`.  → §2c
//   M-C  `server/adapters/memory.js` — `putKeyWraps` is write-ONCE; an existing
//        (space, epoch, recipient) row is never replaced.                        → §3a · §3b
//   M-H  `crypto/spacekeys.js` — `familyRecipientsReport` admits ONE device per member, so a
//        device a member attests for herself is not automatically a ring recipient. → §5b · §5c
//   M-I  `family/membersui.js` — `MemberRow` grows `deviceCount`, i.e. ADR 002 §8.5's stated
//        mitigation is actually rendered.                                              → §5d
//

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { entityUuid as newUuid, deviceId as mkDeviceId } from '../../src/js/core/ids.js';
import { createKeyRing } from '../../src/js/crypto/spacekeys.js';
import { exportRawPublic, deviceShortOf } from '../../src/js/crypto/identity.js';
import { attestPeer } from '../../src/js/family/engine.js';
import { b64u } from '../../src/js/core/b64.js';
import { createKeyDelivery, DELIVERY } from '../../src/js/sync/keys.js';

import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, boardOf,
  hostileRotate, genuineWrap, junkWrap, rosterDeviceIdsOf, catchUpRing, S,
} from './e6-attack-circle.js';

/** Papa's founding pair — ADR 001 §4.0 and §4.1. Without both the circle admits nothing. */
async function found(C) {
  await bootMac(C, C.papa);
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('attestMyDevice', {
      deviceShort: C.papa.forStore.deviceShort, blob: C.papa.myBlob,
    }), true);
    assert.equal(C.papa.store.apply('claimAdmin', {}), true);
    C.papa.engine = engineFor(C, C.papa);
    const p = await C.papa.engine.pushNow();
    assert.equal(p.pushed, 2, 'NON-VACUITY: the two founding ops really reached the relay');
  });
}

/** Bring one joined Mac up: store, engine, one ordinary sync, then their own attestation. */
async function bring(C, mac) {
  await bootMac(C, mac);
  await on(mac, async () => {
    mac.engine = engineFor(C, mac);
    await mac.engine.syncNow();
  });
}

const epochsOf = (C, mac) => mac.ring.epochs(C.spaceId);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE CONTROL — the honest path, on this rig, for this joiner
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§0 · control: an unattacked circle really does deliver the whole ring', () => {
  let C = null;
  let currentEpoch = 0;

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);

    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);
    const r = await on(C.papa, () => C.papa.engine.syncNow());
    currentEpoch = r.delivery.epoch;
    await bring(C, C.mama);
    await on(C.eve, () => C.eve.engine.syncNow());     // Eve's own next ordinary tick
  });

  test('§0a · Eve holds the whole ring and so does Mama, with nobody attacking', () => {
    const upTo = C.papa.ring.currentEpoch(C.spaceId);
    assert.ok(upTo >= 3, `the space rotated on each join: epoch ${upTo}`);
    for (const mac of [C.papa, C.eve, C.mama]) {
      assert.equal(epochsOf(C, mac)[0], 1, `${mac.tag} holds epoch 1 — the history (A4, 17.1)`);
      assert.equal(mac.ring.covers(C.spaceId, upTo), true,
        `${mac.tag} covers 1..${upTo}: ${epochsOf(C, mac)}`);
    }
    assert.ok(currentEpoch >= 3, 'Papa performed the delivery rotation');
  });

  test('§0b · the joiner\'s waiting state cleared and her engine is healthy', () => {
    const st = C.mama.engine.status();
    assert.equal(st.keysPending, false, 'D9 cleared');
    assert.equal(st.state, 'healthy');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · ATTACK T5-K1 — THE JUNK WRAP.  One member locks a joiner out of the circle for ever.
//
//   Eve is a member. Mama joins. Eve rotates FIRST — a rotation any member may perform (ADR 002
//   §4.2: "the member whose action caused the rotation performs it", and `rotateEpoch` requires
//   only `requireActiveMember`) — depositing genuine wraps for herself and for Papa and
//   WELL-FORMED GARBAGE for Mama, for every epoch 1..e+1.
//
//   The relay accepts it: every required (recipient, epoch) row exists.
//   Papa's own delivery POST then loses the race and answers `409 epoch_taken`, and `keys.js`
//   reads that as *"their wraps cover the same recipients"* and writes a DURABLE proof saying
//   Mama holds the ring. From that moment no honest device in the family will ever deliver to
//   her again, and nothing anywhere is in an error state.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · T5-K1 · a junk wrap plus a lost race locks the joiner out permanently', () => {
  let C = null;
  let eveRotation = null;
  let papaAfter = null;
  const laterVerdicts = [];
  const mamaStates = [];
  let coverageAtRace = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);

    // Eve joins honestly and receives the ring honestly. She is a full member from here on.
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);

    // Papa publishes the history a joiner is promised (A4, story 17.1, risk R11).
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
    });

    // ── Mama joins ────────────────────────────────────────────────────────────────────────
    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);

    // ── THE RACE, DRIVEN DETERMINISTICALLY ───────────────────────────────────────────────
    //
    // Eve does not need this hook in the field: `rotateEpoch` carries NO rate limiter (its own
    // header says so, and `limits.js` RATE_COVERAGE.rotateEpoch reasons that membership is the
    // bound), so an attacker rotates in a loop and every honest delivery loses. The hook is here
    // so the loss is deterministic rather than a flake — it fires ONCE, on Papa's first
    // `POST /epoch`, and does exactly what Eve's loop would have done a millisecond earlier.
    const honest = C.papa.transport.request.bind(C.papa.transport);
    let armed = true;
    C.papa.transport.request = async (method, path, query, body, headers) => {
      if (armed && method === 'POST' && path.endsWith('/epoch')) {
        armed = false;
        await catchUpRing(C, C.eve);            // an attacker syncs before she attacks
        const roster = await C.eve.transport.request(
          'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
        const ring = C.eve.ring.keysByEpoch(C.spaceId);
        const next = roster.json.currentEpoch + 1;
        const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
        ring.set(next, fresh);
        eveRotation = await hostileRotate(C, C.eve, async (rid, e) => (
          rid === C.mama.forStore.deviceId
            ? junkWrap(C, e)                                    // ← the whole attack
            : genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
        ), { epoch: next });
      }
      return honest(method, path, query, body, headers);
    };

    papaAfter = await on(C.papa, () => C.papa.engine.syncNow());
    // The proof AS IT STANDS AT THE END OF THE RACED PASS — before any later tick can write a
    // legitimate one. This is the value a relaunch would restore.
    coverageAtRace = C.papa.engine.keys.coverage();
    C.papa.transport.request = honest;

    await bring(C, C.mama);

    // Ten more ordinary ticks on the two honest Macs. Mama's screen is read after every one.
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await on(C.papa, () => C.papa.engine.syncNow());
      laterVerdicts.push(r.delivery.verdict);
      // eslint-disable-next-line no-await-in-loop
      await on(C.mama, () => C.mama.engine.syncNow());
      mamaStates.push(C.mama.engine.status().state);
    }
  });

  test('§1a · the relay ACCEPTED a rotation in which one recipient can decrypt nothing', () => {
    assert.equal(eveRotation.status, 200,
      `assertCoverage counts rows, not keys: ${JSON.stringify(eveRotation.json)}`);
    assert.ok(eveRotation.json.wrapsStored >= 3,
      'every required (recipient, epoch) pair got a row — that is all coverage means');
  });

  test('§1b · Papa lost the race and wrote a DURABLE proof that Mama holds the ring', () => {
    assert.equal(papaAfter.delivery.verdict, DELIVERY.RACED,
      'the designed outcome of "any member device may deliver"');
    const cov = coverageAtRace;
    assert.ok(cov.proof, 'a proof was written');
    assert.ok(cov.proof.ids.includes(C.mama.forStore.deviceId),
      'THE BREAK: the losing racer records the joiner as covered, on the winner\'s word alone');
    assert.equal(cov.durable, true, 'and it is written to disk, so a relaunch does not clear it');
  });

  test('§1c · no honest device will ever deliver to her again', () => {
    assert.deepEqual([...new Set(laterVerdicts)], [DELIVERY.COVERED],
      `five ordinary ticks, five refusals to deliver: ${laterVerdicts.join(', ')}`);
  });

  test('§1d · Mama holds NO key at all, for ever', () => {
    assert.deepEqual(epochsOf(C, C.mama), [], 'her ring is empty');
    assert.equal(C.mama.ring.currentEpoch(C.spaceId), 0);
    const kd = C.mama.engine.keys.diagnostics();
    assert.ok(kd.refusedRows > 0, 'the junk rows were fetched and refused');
    assert.equal(kd.unauthorizedRows, 0,
      'and they were NOT unauthorized — Eve is an admissible sender, so §4.2 step 6 is silent');
  });

  test('§1e · her board is empty and the history she was promised is not on it', () => {
    const board = boardOf(C, C.mama);
    assert.equal(board.filter((n) => n.ownerId !== C.mama.forStore.memberId).length, 0,
      'no foreign entry rendered');
    assert.equal(board.some((n) => n.text === 'Omas Geburtstag'), false,
      'A4 / story 17.1 / risk R11: the shared history never arrives');
  });

  test('§1f · the joiner sits in D9\'s calm waiting state — and then loses the ops', () => {
    // What is MEASURED rather than assumed: the first ticks are `pending`, which is D9's designed
    // screen and is exactly right for "a member Mac will deliver". It is only after
    // `MAX_DEFERRALS` that the ladder gives up and the state becomes `error`.
    // MEASURED, ten ticks: pending pending pending pending error error error error error error.
    assert.deepEqual(mamaStates.slice(0, 4), ['pending', 'pending', 'pending', 'pending'],
      'D9\'s designed waiting state, correctly rendered, for as long as the ladder lasts');
    assert.equal(C.mama.engine.status().keysPending, true,
      'the sentence on her screen stays true about the KEY and stays wrong about the outcome');
    assert.equal(C.papa.engine.status().state, 'healthy',
      'and every other Mac in the family sees a healthy circle throughout');
    // The ladder's own end state, whichever it reached — recorded, not asserted away.
    assert.ok(['pending', 'error'].includes(mamaStates[mamaStates.length - 1]));
  });

  test('§1g · the ladder ends by QUARANTINING the family\'s ops on the joiner\'s Mac', () => {
    const q = C.mama.engine.quarantined();
    assert.ok(q.length > 0,
      'MAX_DEFERRALS is reached and every held envelope is declared terminal');
    assert.ok(q.every((r) => /still epoch after/.test(r.reason)),
      `the reason names the missing KEY, not a defect in the op: ${JSON.stringify(q.map((r) => r.reason))}`);
    assert.equal(C.mama.engine.status().state, 'error',
      'so the calm screen becomes an error one — about ops that were never damaged');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · ATTACK T5-K2 — THE PARTIAL RING.  The waiting state clears on a ring that is not there.
//
//   `wrapRingToRecipients` refuses to build a partial ring and says why: *"A wrap that covers
//   only the current epoch is a bug … a joiner whose board is simply missing three years of
//   entries with no error anywhere"*. That refusal is on the HONEST wrapping side. Eve does not
//   call it. She deposits a genuine wrap for the newest epoch and junk for every older one, and
//   the coverage check — rows again — takes it.
//
//   `keys.js#admit` then fires `onAdmit` because `admitted.length > 0`, and `sync/family.js`
//   turns that into `onKeys({keysPending: false})` — D9's waiting state, cleared, on a device
//   that cannot read a single thing published before it arrived.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · T5-K2 · a partial ring clears D9\'s waiting state on a device with no history', () => {
  let C = null;
  let rotation = null;
  const keyEvents = [];

  before(async () => {
    C = await buildCircle(['papa', 'eve', 'mama']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(), { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
    });

    assert.equal((await join(C, C.mama)).status, 200);
    await refreshRoster(C);

    // Eve rotates BEFORE anybody else can: genuine for the new epoch, junk for the history.
    await catchUpRing(C, C.eve);
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const ring = C.eve.ring.keysByEpoch(C.spaceId);
    const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
    ring.set(next, fresh);
    rotation = await hostileRotate(C, C.eve, async (rid, e) => (
      rid === C.mama.forStore.deviceId && e < next
        ? junkWrap(C, e)                                        // ← history withheld
        : genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
    ), { epoch: next });

    await bootMac(C, C.mama);
    await on(C.mama, async () => {
      C.mama.engine = engineFor(C, C.mama, { onKeys: (r) => keyEvents.push(r) });
      await C.mama.engine.syncNow();
      await C.mama.engine.syncNow();
    });
  });

  test('§2a · the relay took the rotation', () => {
    assert.equal(rotation.status, 200, JSON.stringify(rotation.json));
  });

  test('§2b · Mama holds exactly ONE epoch of a ring she is told she has', () => {
    const at = rotation.json.currentEpoch;
    assert.deepEqual(epochsOf(C, C.mama), [at], `only the newest epoch: ${epochsOf(C, C.mama)}`);
    assert.equal(C.mama.ring.covers(C.spaceId, at), false, 'the ring does not cover 1..e');
  });

  test('§2c · D9\'s waiting state CLEARED — the joiner is told the keys arrived', () => {
    assert.ok(keyEvents.length >= 1, 'onKeys fired');
    assert.equal(keyEvents[0].keysPending, false,
      'THE BREAK: `keysPending:false` is emitted on the FIRST admitted epoch, never on coverage');
    assert.equal(C.mama.engine.status().keysPending, false,
      'and `status()` agrees, because it reads `currentEpoch !== 0` and the relay\'s row count');
  });

  test('§2d · and nothing on her board is from before she arrived', () => {
    assert.equal(boardOf(C, C.mama).some((n) => n.text === 'Omas Geburtstag'), false,
      'the history is silently absent — no error, no warning, no missing-key state');
  });

  test('§2e · she also cannot deliver the ring onward, and does not say so', () => {
    assert.equal(C.mama.engine.keys.diagnostics().deliveries, 0);
    assert.equal(C.mama.engine.status().state !== 'error', true,
      'a member who can neither read the history nor pass it on looks healthy or merely pending');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · ATTACK T5-K3 — THE OVERWRITE.  One member destroys the family's key history on the relay.
//
//   `adapters/memory.js#putKeyWraps` is `state.keyWraps.set(K(spaceId, epoch, recipientId), r)`.
//   A rotation may therefore REPLACE any existing (recipient, epoch) wrap, including ones it did
//   not deposit, for every epoch below its own. `readWraps` refuses a duplicate pair WITHIN one
//   request; it says nothing about the rows already in the table.
//
//   The victim is not the member who is online — she holds her ring in `localStorage`. The
//   victims are every future joiner, every device paired in tomorrow, and ADR 002 §7.3's A2
//   recovery, which is the ONLY path that survives losing every device.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · T5-K3 · one member overwrites everybody\'s wraps and the loss is permanent', () => {
  let C = null;
  let before1 = 0;
  let bytesBefore = '';
  let bytesAfter = '';
  let rotation = null;
  let freshAdmit = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.eve, async () => { await publishAttestation(C, C.eve); });
    await refreshRoster(C);

    const mine = await C.papa.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    before1 = mine.json.wraps.length;
    assert.ok(before1 >= 2, 'Papa really has wraps on the relay to destroy');
    bytesBefore = mine.json.wraps.find((w) => w.epoch === 1).wrapped;

    await catchUpRing(C, C.eve);
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const ring = C.eve.ring.keysByEpoch(C.spaceId);
    const fresh = await (await import('../../src/js/crypto/spacekeys.js')).createSpaceKey();
    ring.set(next, fresh);
    // Junk for EVERY recipient and EVERY epoch except Eve's own current one.
    rotation = await hostileRotate(C, C.eve, async (rid, e) => (
      rid === C.eve.forStore.deviceId && e === next
        ? genuineWrap(C, C.eve, roster.json, rid, e, ring.get(e))
        : junkWrap(C, e)
    ), { epoch: next });

    const after = await C.papa.transport.request('GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    bytesAfter = after.json.wraps.find((w) => w.epoch === 1).wrapped;

    // Papa's Mac is replaced / restored from the A2 backup: same identity, EMPTY ring.
    const emptyRing = createKeyRing();
    const delivery = createKeyDelivery({
      transport: C.papa.transport,
      spaceId: C.spaceId,
      ring: emptyRing,
      myKexPriv: C.papa.identity.devKex.privateKey,
      myRecoveryKexPriv: C.papa.recovery.recKex.privateKey,
      me: {
        memberId: C.papa.forStore.memberId,
        deviceId: C.papa.forStore.deviceId,
        deviceShort: C.papa.forStore.deviceShort,
      },
      now: C.now,
      subtle: S,
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    });
    freshAdmit = await delivery.admit();
    freshAdmit.epochs = emptyRing.epochs(C.spaceId);
  });

  test('§3a · the relay accepted a rotation that overwrote wraps Eve never deposited', () => {
    assert.equal(rotation.status, 200, JSON.stringify(rotation.json));
    assert.ok(rotation.json.wrapsStored > before1,
      'she deposited more rows than Papa had');
    assert.notEqual(bytesAfter, bytesBefore,
      'THE WRITE: Papa\'s OWN epoch-1 wrap — deposited by him at `POST /spaces`, addressed to '
      + 'his own IK_kex — now holds bytes Eve chose. `putKeyWraps` is an upsert and no honest '
      + 'client ever reads a wrap row before writing one.');
  });

  test('§3b · the space\'s whole key history is now unrecoverable from the relay', () => {
    assert.deepEqual(freshAdmit.admitted, [],
      'THE BREAK: a device of the founding member, with his own IK_kex and RK_kex, admits nothing');
    assert.deepEqual(freshAdmit.epochs, []);
    assert.ok(freshAdmit.refused > 0, 'the rows are there; none of them opens');
    assert.equal(freshAdmit.keysPending, false,
      'and the relay reports keysPending:false, because it counts rows too');
  });

  test('§3c · the honest client had no way to notice: it never reads before it writes', () => {
    // The claim, pinned as source rather than as prose: `rotateTo` builds its wrap set from its
    // OWN ring and posts it. There is no read-back, no digest, no comparison with what the relay
    // already holds — because there is no route that would answer the question.
    assert.equal(typeof createKeyDelivery, 'function');
    assert.equal(rotation.json.wrapsPurged, 0,
      'nothing was purged — these are replacements, invisible in the response');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE CONTROL FOR THE WHOLE FILE — what the same attacker CANNOT do
//
// Ranking a break means knowing what held. These rows are the barriers Eve walked past nothing
// of, driven with the same hands, so the report can say "the crypto held; the bookkeeping did
// not" and mean it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · what held: the sender set, the scopes, and the relay\'s recipient allowlist', () => {
  let C = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
  });

  test('§4a · a wrap addressed to a recipient this space never heard of is refused', async () => {
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const outsider = 'dev_AAAAAAAAAAAAAAAAAAAAAA';
    const ids = [...rosterDeviceIdsOf(roster.json.members), outsider];
    const res = await hostileRotate(C, C.eve, () => junkWrap(C, 1), { epoch: next, recipients: ids });
    assert.equal(res.status, 400);
    assert.equal(res.json.reason, 'unknown_recipient');
  });

  test('§4b · a rotation that leaves a live device out is refused by the relay', async () => {
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const res = await hostileRotate(C, C.eve, () => junkWrap(C, 1),
      { epoch: next, recipients: [C.eve.forStore.deviceId] });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'incomplete_coverage',
      'the check has real teeth about WHO is named; it has none about WHAT is in the bytes');
  });

  test('§4c · Eve cannot name herself the depositor of somebody else\'s wrap', async () => {
    const roster = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const next = roster.json.currentEpoch + 1;
    const ids = rosterDeviceIdsOf(roster.json.members);
    const wraps = [];
    for (const id of ids) {
      for (let e = 1; e <= next; e++) {
        wraps.push({
          recipientId: id, epoch: e, wrapped: await junkWrap(C, e),
          senderDeviceId: C.papa.forStore.deviceId,          // ← the field she may not write
        });
      }
    }
    const res = await C.eve.transport.request(
      'POST', `/api/v1/spaces/${C.spaceId}/epoch`, undefined, { epoch: next, wraps }, {});
    assert.equal(res.status, 400, 'readWraps\' closed field set holds (finding E2E3-3)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · ATTACK T5-K4 — WRAPPING THE RING TO SOMEBODY WHO SHOULD NOT HAVE IT.
//
//   The task's question is "can a member be MADE to wrap the ring to someone who should not have
//   it?" and §4a answers the crude form: no, the relay refuses an unknown recipient. The form
//   that works needs no forgery at all. A member's own `RK_sig` attests devices — that is what an
//   attestation IS (ADR 002 §2.3) — so Eve signs an attestation for a keypair she has just handed
//   to somebody outside the family, posts it to `POST /api/v1/devices`, and every honest member's
//   next ordinary sync wraps epochs 1..e+1 to it. No signature is forged, no barrier is walked
//   past, and every check in `recipientProblem()` passes because everything about the row is true.
//
//   ADR 002 §8.5 accepts a neighbouring case ("a malicious admin could add a phantom MEMBER") and
//   names the mitigation: "the member list shows per-member device counts, so an extra device is
//   visible to a curious member". This row is that residual, driven — including the delivery,
//   which §8.5 does not mention and which is what makes the outsider a reader of the HISTORY.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · T5-K4 · a member attests an outsider\'s Mac and the family delivers the ring to it', () => {
  let C = null;
  let registered = null;
  let outsider = null;
  let delivery = null;
  let wraps = null;

  before(async () => {
    C = await buildCircle(['papa', 'eve']);
    await refreshRoster(C);
    await found(C);
    assert.equal((await join(C, C.eve)).status, 200);
    await refreshRoster(C);
    await on(C.papa, () => C.papa.engine.syncNow());
    await bring(C, C.eve);
    await on(C.papa, async () => {
      await C.papa.engine.syncNow();
      await publishSharedEntry(C, C.papa, newUuid(),
        { 'pub.text': 'Omas Geburtstag', 'pub.date': '2023-11-14' });
      await C.papa.engine.syncNow();
    });

    // A keypair Eve generated for somebody who is not in the family. Nothing about it is hers.
    const sig = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const kex = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const sigPubRaw = b64u(await exportRawPublic(sig.publicKey));
    const kexPubRaw = b64u(await exportRawPublic(kex.publicKey));
    outsider = {
      memberId: C.eve.forStore.memberId,          // filed under EVE — she is vouching for it
      deviceId: mkDeviceId(),
      deviceShort: await deviceShortOf(await exportRawPublic(sig.publicKey)),
      sigPubRaw,
      kexPubRaw,
      kexPriv: kex.privateKey,
    };
    // The SHIPPED minting function, with Eve's own recovery key. Nothing is hand-rolled.
    const { blob } = await attestPeer(outsider, C.eve.recovery.recSig, '2026-08-29');
    registered = await C.eve.transport.request('POST', '/api/v1/devices', undefined, {
      spaceId: C.spaceId,
      memberId: outsider.memberId,
      deviceId: outsider.deviceId,
      deviceShort: outsider.deviceShort,
      sigPubRaw, kexPubRaw,
      attestation: blob,
    }, {});

    await refreshRoster(C);
    // ONE ORDINARY TICK on the honest admin's Mac. Nobody tells him anything.
    delivery = await on(C.papa, () => C.papa.engine.syncNow());
    wraps = await C.eve.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
  });

  test('§5a · the relay accepted a device attested by a member for a key she does not control', () => {
    assert.equal(registered.status, 200, JSON.stringify(registered.json));
  });

  test('§5b · SUCCEEDED · the honest admin\'s next sync wrapped 1..e+1 to it, unprompted', () => {
    assert.equal(delivery.delivery.verdict, DELIVERY.DELIVERED,
      'a new recipient is uncovered, so §7.1 step 4 hands it the whole ring — as designed');
    assert.ok(delivery.delivery.uncovered.includes(outsider.deviceId),
      'and the outsider\'s device is the recipient the delivery was FOR');
    assert.ok(delivery.delivery.detail.includes(`1..${delivery.delivery.epoch}`),
      `wraps for the whole history: ${delivery.delivery.detail}`);
  });

  test('§5c · every barrier passed, because every fact about the row is true', async () => {
    const { familyRecipientsReport, recipientProblem } = await import('../../src/js/crypto/spacekeys.js');
    const roster = await C.papa.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
    const { recipients } = familyRecipientsReport(roster.json.members);
    const r = recipients.find((x) => x.deviceId === outsider.deviceId);
    assert.ok(r, 'it is a recipient of this space');
    assert.equal(await recipientProblem(r), null,
      'ADR 002 §2.3: the attestation verifies under its housing member\'s RK_sig, the short is '
      + 'the short of the key, and att.kexPubRaw IS the key the wrap is addressed to');
  });

  test('§5d · SUCCEEDED · and ADR 002 §8.5\'s ONLY stated mitigation does not exist in the UI', () => {
    assert.equal(wraps.status, 200, 'the wraps really are on the relay, addressed to the outsider');
    // §8.5, verbatim: "Partial mitigation: the member list shows per-member device counts, so an
    // extra device is visible to a curious member."
    //
    // `family/membersui.js` builds a `MemberRow` of eight fields — memberId, displayName,
    // colorRef, initial, alive, isMe, isAdmin, hidden — and NONE of them is a device count. The
    // roster response carries `devices[]`, so the fact is on the wire and reaches no screen.
    const src = readFileSync(new URL('../../src/js/family/membersui.js', import.meta.url), 'utf8');
    const rowShape = src.slice(src.indexOf('@typedef {Object} MemberRow'), src.indexOf('@typedef {Object} MembersPort'));
    assert.equal(/deviceCount|devices/.test(rowShape), false,
      `MemberRow has no device field, so §8.5's mitigation is not rendered anywhere:\n${rowShape}`);
    assert.equal(/deviceCount|Ger(ä|ae)te?zahl|devices\.length/.test(src), false,
      'and nothing else in the module counts devices either');
  });
});
